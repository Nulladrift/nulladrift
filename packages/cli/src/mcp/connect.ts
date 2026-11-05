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
import { VERSION } from "../lib/version";
import { UnreachableServerError } from "./types";

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Enough of a server's own diagnostics to act on, without pasting a log into the terminal. */
const STDERR_KEEP_BYTES = 2_000;

export interface Connection {
  client: Client;
  /** Whatever the server wrote to stderr, for stdio servers that failed to answer. */
  stderr(): string;
  close(): Promise<void>;
}

export function buildTransport(
  server: ConfiguredServer,
  captureStderr: (chunk: string) => void = () => {},
  options: { interactive?: boolean } = {},
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

  const headers = { ...transport.headers, "user-agent": `nulladrift/${VERSION}` };
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

  if (transport.type === "sse") return new SSEClientTransport(url, { requestInit: { headers }, authProvider });

  return new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider });
}

export async function connect(server: ConfiguredServer, timeoutMs = DEFAULT_TIMEOUT_MS, options: { interactive?: boolean } = {}): Promise<Connection> {
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

  let transport: Transport;
  try {
    transport = buildTransport(server, captureStderr, options);
  } catch (error) {
    throw new UnreachableServerError(server.name, `could not prepare transport: ${(error as Error).message}`, error);
  }

  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    await client.close().catch(() => {});
    const detail = stderrBuffer.trim();
    throw new UnreachableServerError(
      server.name,
      `${(error as Error).message}${detail ? `\n  server stderr: ${detail.split("\n").slice(-3).join("\n  ")}` : ""}`,
      error,
    );
  }

  return {
    client,
    stderr: () => stderrBuffer,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}
