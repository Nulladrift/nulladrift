/**
 * Opening a connection to a configured server.
 *
 * Protocol revision 2026-07-28 removed the `initialize` handshake: a modern server is stateless
 * and must implement `server/discover`, while servers on 2025-11-25 and earlier still expect the
 * handshake. The SDK can probe for this, but defaults to legacy, so `auto` is set explicitly --
 * without it a modern-only server would look unreachable.
 */
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Transport } from "@modelcontextprotocol/client";
import type { ConfiguredServer } from "../config/types";
import { createAuthProvider } from "./oauth";
import { USER_AGENT, VERSION } from "../lib/version";
import { boundReason, MAX_REASON_CHARS, UnreachableServerError } from "./types";
import { describeNetworkFailure } from "./network";

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Enough of a server's own diagnostics to act on, without pasting a log into the terminal. */
const STDERR_KEEP_BYTES = 2_000;

export interface Connection {
  client: Client;
  /** Whatever the server wrote to stderr, for stdio servers that failed to answer. */
  stderr(): string;
  /**
   * Why this connection stopped reading the server, when it did: a reply this tool cannot read
   * as sent, or more than a server may send. Takes precedence over whatever error the pending
   * request then fails with, which only says the connection closed.
   */
  refused(): string | undefined;
  /**
   * Which lists the server said changed since the last `watchChanges()`: `tools`, `resources`,
   * `prompts`. A listing read while one of these arrived may not be the list the server now has.
   */
  watchChanges(): void;
  changed(): string[];
  close(): Promise<void>;
}

/**
 * Everything one server may send during an audit, all replies together.
 *
 * A server answering 64 pages of 60,000 tools ran the audit out of memory in 29 seconds, inside
 * the default timeout: the process died with exit 134 rather than reporting the server, and in
 * the crawl one listed server killed the whole run. A surface a hundred times the largest
 * published one is still well under this.
 */
export const MAX_SURFACE_BYTES = 32 * 1024 * 1024;

/** Counts what a server sends, and stops reading it when it says something this tool must not pin. */
class SurfaceGuard {
  private messageBytes = 0;
  private wireBytes = 0;
  refusal: string | undefined;

  constructor(private readonly stop: () => void) {}

  refuse(reason: string): void {
    if (this.refusal !== undefined) return;
    this.refusal = reason;
    this.stop();
  }

  /** Bytes as they arrive over HTTP, before anything is parsed. */
  received(bytes: number): boolean {
    this.wireBytes += bytes;
    if (this.wireBytes <= MAX_SURFACE_BYTES) return true;
    this.refuse(tooLarge());
    return false;
  }

  /** A parsed message, before the client library sees it. False when it must not be passed on. */
  admit(message: unknown): boolean {
    if (this.refusal !== undefined) return false;
    const { bytes, prototypeKey } = inspectMessage(message);
    /*
     * The client library validates every reply against the specification's schemas, and in
     * rebuilding the objects drops any own key named `__proto__`. A tool parameter by that name
     * never reached the lock, so changing its description -- text a client that keeps raw keys
     * does show the model -- compared clean. It is not a name anything legitimate uses, and a
     * surface that cannot be read as it was sent cannot be pinned.
     */
    if (prototypeKey) {
      this.refuse("the server's reply contains a key named `__proto__`, which the MCP client library drops before it can be read; a surface that cannot be read as it was sent cannot be pinned");
      return false;
    }
    this.messageBytes += bytes;
    if (this.messageBytes > MAX_SURFACE_BYTES) {
      this.refuse(tooLarge());
      return false;
    }
    return true;
  }
}

function tooLarge(): string {
  return `the server sent more than ${MAX_SURFACE_BYTES / 1024 / 1024} MB while being audited, so it was stopped there; nothing was pinned`;
}

/** Approximate size, and whether any object has an own key named `__proto__`. Iterative: depth is the server's to choose. */
function inspectMessage(message: unknown): { bytes: number; prototypeKey: boolean } {
  let bytes = 0;
  let prototypeKey = false;
  const pending: unknown[] = [message];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node === "string") bytes += node.length + 2;
    else if (Array.isArray(node)) {
      bytes += 2;
      for (const member of node) pending.push(member);
    } else if (node !== null && typeof node === "object") {
      bytes += 2;
      if (Object.hasOwn(node, "__proto__")) prototypeKey = true;
      for (const key of Object.keys(node)) {
        bytes += key.length + 3;
        pending.push((node as Record<string, unknown>)[key]);
      }
    } else bytes += 5;
  }
  return { bytes, prototypeKey };
}

const INSPECTED = Symbol("nulladrift.inspected");
type MessageHandler = NonNullable<Transport["onmessage"]> & { [INSPECTED]?: true };

/**
 * Puts the guard in front of whatever handler the client library installs, every time it
 * installs one. The library replaces `onmessage` during version negotiation and puts its saved
 * handler back afterwards, so this wraps on assignment, and a handler it already wrapped is kept
 * as it is rather than counted twice.
 */
function guardMessages(transport: Transport, guard: SurfaceGuard): void {
  let current: MessageHandler | undefined;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (handler: MessageHandler | undefined) => {
      if (handler === undefined || handler[INSPECTED]) {
        current = handler;
        return;
      }
      const wrapped: MessageHandler = ((message: Parameters<MessageHandler>[0], extra?: Parameters<MessageHandler>[1]) => {
        if (guard.admit(message)) handler(message, extra);
      }) as MessageHandler;
      wrapped[INSPECTED] = true;
      current = wrapped;
    },
  });
}

/** `fetch`, with what each response may add to the guard's count checked as it streams in. */
function guardedFetch(guard: SurfaceGuard): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (!guard.received(value.byteLength)) {
          await reader.cancel().catch(() => {});
          controller.error(new Error(guard.refusal));
          return;
        }
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

/*
 * A line break or NUL in a header value or an environment value is refused before anything
 * is sent or started, and the refusal names the header or variable and never the value. Node's
 * own refusal quotes the whole value -- `Headers.append: "Token acme\n:sk-live-..." is an
 * invalid header value` -- and that message went into the reason, the pull request comment and
 * the reading. A secret read from a file with a trailing newline, beside another, was enough.
 */
const UNSENDABLE = /[\r\n\0]/;

function refuseUnsendable(server: ConfiguredServer): void {
  const { transport } = server;
  if (transport.type === "stdio") {
    for (const [name, value] of Object.entries(transport.env)) {
      if (value.includes("\0")) throw new UnreachableServerError(server.name, `the environment variable ${name} contains a NUL character, which a process cannot be given; check where its value comes from`);
    }
    transport.args.forEach((arg, index) => {
      if (arg.includes("\0")) throw new UnreachableServerError(server.name, `argument ${index + 1} contains a NUL character, which a process cannot be given`);
    });
    return;
  }
  for (const [name, value] of Object.entries(transport.headers)) {
    if (UNSENDABLE.test(value)) {
      throw new UnreachableServerError(
        server.name,
        `the value of the ${name} header contains a line break or NUL, which HTTP does not allow; check the variable it is read from (a secret saved with a trailing newline is the usual cause)`,
      );
    }
  }
}

export function buildTransport(
  server: ConfiguredServer,
  captureStderr: (chunk: string) => void = () => {},
  options: { interactive?: boolean; fetch?: typeof fetch } = {},
): Transport {
  const { transport } = server;

  if (transport.type === "stdio") {
    const child = new StdioClientTransport({
      command: transport.command,
      args: transport.args,
      // The server's own environment plus whatever the config sets. Never the auditor's full env.
      env: { ...getDefaultEnvironment(), ...transport.env },
      cwd: transport.cwd,
      // Piped rather than inherited: a chatty server must not interleave with our report, but its
      // last words are the most useful thing we can show when it fails to answer.
      stderr: "pipe",
    });
    child.stderr?.on("data", (chunk: Buffer) => captureStderr(chunk.toString("utf8")));
    return child;
  }

  /*
   * A config that sets its own `user-agent` keeps it: some servers key on it, and overriding a
   * deliberate choice would audit a server under conditions the owner never configured. Header
   * names are not case-sensitive, so the default is left out whatever case the config writes it
   * in: spread after it as `User-Agent`, it was a second header, and the server received the two
   * joined -- "nulladrift/0.10.0 (...), Custom/1.0" -- which is neither.
   */
  const ownAgent = Object.keys(transport.headers).some((name) => name.toLowerCase() === "user-agent");
  const headers = { ...(ownAgent ? {} : { "user-agent": USER_AGENT }), ...transport.headers };
  const url = new URL(transport.url);

  /*
   * HTTP+SSE has been deprecated since revision 2025-03-26 and is now Deprecated under the
   * feature lifecycle policy. A config that still declares it is audited on its own transport
   * rather than silently over Streamable HTTP, which would fail in a way that looked like the
   * server was down. `init` says so in its output.
   */
  // Present only when the config asked for OAuth or a prior `login` stored tokens; the SDK
  // refreshes them and retries a 401 on its own.
  const authProvider = createAuthProvider(server, options);

  const custom = options.fetch ? { fetch: options.fetch } : {};
  if (transport.type === "sse") return new SSEClientTransport(url, { requestInit: { headers }, authProvider, ...custom });

  return new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider, ...custom });
}

/** How long a server stopped at its deadline has after SIGTERM before it is killed. */
const KILL_GRACE_MS = 1_000;

/**
 * Server processes that may still be running: signalled and not yet killed, being closed by the
 * SDK (which forgets the pid as soon as it starts), or open.
 */
const signalled = new Set<number>();
const closing = new Set<number>();
const open = new Set<StdioClientTransport>();
let exitHooked = false;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/**
 * A server process stopped now: SIGTERM, then SIGKILL a second later if it is still there.
 *
 * Not the SDK's close, which waits two seconds for the server to leave on its own before it
 * signals at all. `main` exits two seconds after it returns, so a stdio server that ignored the end
 * of its input outlived the CLI and was re-parented to PID 1, on every CI run that met one. Its pid
 * is held only until the SIGKILL, so it cannot outlast the process and name another one.
 */
function stopProcess(pid: number): void {
  if (!isRunning(pid)) return;
  signalled.add(pid);
  signal(pid, "SIGTERM");
  setTimeout(() => {
    if (isRunning(pid)) signal(pid, "SIGKILL");
    signalled.delete(pid);
  }, KILL_GRACE_MS).unref();
}

/**
 * Nothing this run started survives it. On exit, every server process still open or still being
 * stopped is killed: `process.exit` does not wait for a grace period, and neither does this.
 */
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const pid of [...signalled, ...closing]) signal(pid, "SIGKILL");
    for (const transport of open) if (transport.pid !== null) signal(transport.pid, "SIGKILL");
  });
}

/**
 * The lines of a crash worth showing, which are almost never the last ones.
 *
 * This used to take `slice(-3)`. A Node process that dies on startup ends with the closing brace
 * of its own stack frame, a blank line and its version banner, so the tail is reliably the three
 * least informative lines it produced, and the reason was cut off above them. Against a real
 * server whose entry point had not been built, the report read:
 *
 *     server stderr: }
 *
 *     Node.js v26.7.0
 *
 * while the line that explained it, `Error: Cannot find module '.../dist/index.js'`, was dropped.
 *
 * So: keep the lines that name a failure, drop stack frames and the interpreter's own furniture,
 * and fall back to the first real lines rather than the last.
 */
export function diagnosticLines(stderr: string, limit = 3): string[] {
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    // Stack frames, the caret a syntax error points with, a lone brace, and `Node.js vNN.N.N`.
    .filter((line) => !/^\s*(at\s|\^+$|[}\])]+$|Node\.js v[\d.]+$)/.test(line));

  const named = lines.filter((line) => /\b(error|exception|cannot|failed|refused|denied|not found|enoent|eacces)\b/i.test(line));
  const chosen = named.length > 0 ? named : lines;
  return chosen.slice(0, limit).map((line) => line.trim());
}

export async function connect(
  server: ConfiguredServer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: {
    interactive?: boolean;
    /** Aborted when the caller gives up on the server: it is stopped there and then, process and all. */
    signal?: AbortSignal;
  } = {},
): Promise<Connection> {
  let stderrBuffer = "";
  const captureStderr = (chunk: string): void => {
    stderrBuffer = (stderrBuffer + chunk).slice(-STDERR_KEEP_BYTES);
  };

  const client = new Client(
    { name: "nulladrift", title: "nulladrift", version: VERSION },
    {
      /*
       * We advertise nothing. An auditor never calls a tool, so it has no business offering
       * elicitation, sampling or roots -- a server that asks for them gets nothing to work with.
       */
      capabilities: {},
      versionNegotiation: { mode: "auto", probe: { timeoutMs } },
    },
  );

  refuseUnsendable(server);

  /*
   * Each list's `list_changed` notification, recorded rather than acted on. Registered before the
   * connection opens, so one sent the moment it does is not missed; what counts is whether one
   * arrives while the lists are being read, which capture asks after each pass.
   */
  const changes = new Set<string>();
  for (const [list, method] of [
    ["tools", "notifications/tools/list_changed"],
    ["resources", "notifications/resources/list_changed"],
    ["prompts", "notifications/prompts/list_changed"],
  ] as const) {
    client.setNotificationHandler(method, () => {
      changes.add(list);
    });
  }

  let transport: Transport | undefined;
  /*
   * Stopped, not asked to leave: at the deadline, and when the guard stops reading a server. The
   * process first, since closing the transport forgets which process it was; closing it as well
   * ends a version probe in progress, whose disposable process the SDK then reaps itself.
   */
  const stop = (): void => {
    if (transport instanceof StdioClientTransport) {
      open.delete(transport);
      if (transport.pid !== null) stopProcess(transport.pid);
    }
    void transport?.close().catch(() => {});
  };
  const guard = new SurfaceGuard(stop);
  try {
    transport = buildTransport(server, captureStderr, { ...options, fetch: guardedFetch(guard) });
  } catch (error) {
    throw new UnreachableServerError(server.name, `could not prepare transport: ${(error as Error).message}`, error);
  }
  guardMessages(transport, guard);

  const built = transport;
  if (built instanceof StdioClientTransport) {
    hookExit();
    open.add(built);
    /*
     * The SDK starts the server's own process only once its probe has finished, which can be after
     * the caller gave up: the deadline passing during the probe left nothing to stop yet, and then a
     * process was started that nobody would.
     */
    const start = built.start.bind(built);
    built.start = async () => {
      await start();
      if (options.signal?.aborted) {
        stop();
        throw new UnreachableServerError(server.name, "stopped: the deadline passed while it was starting");
      }
    };
  }
  options.signal?.addEventListener("abort", stop, { once: true });
  /** The SDK's own close, which asks the server to leave; its pid kept so an exit mid-close still kills it. */
  const close = async (): Promise<void> => {
    options.signal?.removeEventListener("abort", stop);
    const pid = built instanceof StdioClientTransport ? built.pid : null;
    if (pid !== null) closing.add(pid);
    if (built instanceof StdioClientTransport) open.delete(built);
    await client.close().catch(() => {});
    if (pid !== null) closing.delete(pid);
  };

  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    if (options.signal?.aborted) stop();
    await close();
    if (guard.refusal !== undefined) throw new UnreachableServerError(server.name, guard.refusal, error);
    const detail = stderrBuffer.trim();
    // The network's own reason, when there is one: "fetch failed" alone does not say what to fix.
    const network = describeNetworkFailure(error);
    // Half the bound at most, so a long error body leaves room for the stderr that explains it.
    throw new UnreachableServerError(
      server.name,
      `${boundReason((error as Error).message, MAX_REASON_CHARS / 2)}${network ? ` (${network})` : ""}${detail ? `\n  server stderr: ${diagnosticLines(detail).join("\n  ")}` : ""}`,
      error,
    );
  }

  return {
    client,
    stderr: () => stderrBuffer,
    refused: () => guard.refusal,
    watchChanges: () => changes.clear(),
    changed: () => [...changes].sort(),
    close,
  };
}
