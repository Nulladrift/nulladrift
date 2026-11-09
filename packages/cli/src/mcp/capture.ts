/** Asking a connected server for everything it exposes. */
import type { Client, Tool } from "@modelcontextprotocol/client";
import type { ConfiguredServer } from "../config/types";
import type { JsonObject, LockedProtocol, LockedServerInfo } from "../lock/types";
import { toJson } from "../lock/canonical";
import { connect, DEFAULT_TIMEOUT_MS } from "./connect";
import type { CapturedSurface } from "./types";
import { UnreachableServerError } from "./types";

/*
 * Lists are fetched with the cache bypassed. The SDK caches list results against the server's
 * `ttlMs` hint, which is exactly the wrong behaviour for an audit: a server could serve a stale
 * tool list and the check would pass against a surface nobody re-fetched.
 */
const FRESH = { cacheMode: "bypass" } as const;

/**
 * `Maximum call stack size exceeded` is what a server gets told it did wrong when it declares a
 * schema nested tens of thousands deep: the validator recurses over the declaration before any of
 * this code sees it. The refusal is correct -- nothing is pinned and the audit fails -- but the
 * message describes an implementation detail of the parser rather than the thing the operator has
 * to decide about, and sends them looking for a bug here.
 *
 * Canonicalization already refuses past a hundred levels in words that say so. This gives the
 * same answer for a surface that does not survive being parsed at all.
 */
/**
 * A schema validation failure, said in one line instead of dumped.
 *
 * When a server's reply does not match the specification the SDK raises the validator's own
 * issue array, and that array reaches the operator verbatim: forty lines of `code`, `values` and
 * `path` for what is usually one mistake repeated once per tool. It buries the finding, it buries
 * every other server in the report under it, and it reads like a crash in this tool rather than
 * a defect in the server being audited.
 *
 * `@modelcontextprotocol/server-filesystem@2025.8.21` is a real example: every tool declares an
 * `inputSchema` whose `type` is not `"object"`, which is fourteen identical issues.
 */
function describeValidationIssues(message: string): string | undefined {
  const start = message.indexOf("[");
  if (start < 0) return undefined;

  let issues: Array<{ path?: unknown[]; message?: string }>;
  try {
    issues = JSON.parse(message.slice(start)) as Array<{ path?: unknown[]; message?: string }>;
  } catch {
    return undefined;
  }
  if (!Array.isArray(issues) || issues.length === 0) return undefined;

  const where = (issue: { path?: unknown[] }): string =>
    (issue.path ?? [])
      .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
      .join("")
      .replace(/^\./, "");

  // Grouped, because one malformed field per tool is one defect reported fourteen times.
  const byMessage = new Map<string, string[]>();
  for (const issue of issues) {
    const text = issue.message ?? "did not validate";
    byMessage.set(text, [...(byMessage.get(text) ?? []), where(issue)]);
  }

  const lines = [...byMessage].slice(0, 3).map(([text, paths]) => {
    const rest = paths.length > 1 ? ` (and ${paths.length - 1} more like it)` : "";
    return `${paths[0]}: ${text}${rest}`;
  });
  const more = byMessage.size > 3 ? ` +${byMessage.size - 3} other problem(s)` : "";

  return `this server's reply does not match the MCP specification, so nothing was pinned for it. ${lines.join("; ")}${more}. This is a defect in the server, not in your project; the usual cause is an old release predating a tightening of the schema.`;
}

export function describeListFailure(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (error instanceof RangeError || /maximum call stack|stack size exceeded|too much recursion/i.test(message)) {
    return "the declared surface is nested too deeply to parse. Nothing was pinned. A legitimate schema is a few levels deep; this one is deep enough to exhaust the parser, which is a property of the declaration and not of your project.";
  }
  if (/invalid result for|invalid literal|invalid_value|invalid_type/i.test(message)) {
    const described = describeValidationIssues(message);
    if (described) return described;
  }
  return message;
}

/** The same ceiling the SDK applies to its own paging (DEFAULT_LIST_MAX_PAGES). */
const MAX_LIST_PAGES = 64;

/**
 * Every tool the server declares, exactly as declared.
 *
 * The SDK's `listTools` drops any tool whose `x-mcp-header` declarations break SEP-2243's rules,
 * because the spec tells a Streamable HTTP client to. That is right for a client about to call
 * tools and wrong for an auditor: older-protocol and stdio clients still offer such a tool, so a
 * server could add one (`exec_shell`) that this never saw and `check` passed. `client.request`
 * returns the page as sent; paged by hand, with the SDK's own limit and a stop on a repeated
 * cursor so a server cannot keep it listing forever.
 */
async function listAllTools(client: Client, timeoutMs: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = (await client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, { timeout: timeoutMs })) as {
      tools: Tool[];
      nextCursor?: string;
    };
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined) return tools;
    if (cursors.has(cursor)) throw new Error("tools/list: the server repeated a page cursor, so the listing would never end");
    cursors.add(cursor);
  }
  throw new Error(`tools/list: more than ${MAX_LIST_PAGES} pages; the server's pagination did not end`);
}

async function listOrEmpty<T>(label: string, serverName: string, fetchList: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fetchList();
  } catch (error) {
    /*
     * A server that declares a capability and then fails the matching list call is not giving us
     * a surface to pin, so this is an audit failure rather than an empty section. Capability it
     * never declared returns an empty list from the SDK and never reaches here.
     */
    throw new UnreachableServerError(serverName, `${label} failed: ${describeListFailure(error)}`, error);
  }
}

function readProtocol(client: Client): LockedProtocol {
  const era = client.getProtocolEra() ?? "legacy";
  const version = client.getNegotiatedProtocolVersion() ?? "unknown";
  const discovered = client.getDiscoverResult();
  return {
    era,
    version,
    supportedVersions: discovered?.supportedVersions,
  };
}

function readServerInfo(client: Client): LockedServerInfo | undefined {
  const info = client.getServerVersion();
  if (!info) return undefined;
  return {
    name: info.name,
    title: info.title,
    version: info.version,
    description: info.description,
    websiteUrl: info.websiteUrl,
  };
}

/**
 * One deadline for the whole of a server, not one per request to it.
 *
 * `--timeout` says "per-server timeout" and was applied to each request. Capturing a surface
 * takes several -- version negotiation, the legacy fallback, then the listings -- so a server
 * that accepts a connection and never answers held the audit for two and a half to three times
 * the configured value. Measured: `--timeout 2000` took 6.1s, `--timeout 4000` took 10.1s. At
 * the 30s default that is a minute and a half per server, which a server nobody controls gets
 * to decide. The crawl had no ceiling at all: a server answering each of 64 pages just inside
 * the request timeout held it for twenty minutes.
 *
 * The per-request timeout stays, because it is what makes an individual call give up. This is
 * the ceiling on all of them together, and it closes the connection when it passes: stopping
 * only the wait left the listing running, and a stdio server running, behind it.
 */
export async function captureSurface(server: ConfiguredServer, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CapturedSurface> {
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const late = (): UnreachableServerError => new UnreachableServerError(server.name, `did not finish within ${timeoutMs}ms`);

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      void connection?.close();
      reject(late());
    }, timeoutMs);
    timer.unref?.();
  });

  const work = (async () => {
    const opened = await connect(server, timeoutMs);
    if (expired) {
      await opened.close();
      throw late();
    }
    connection = opened;
    try {
      return await readSurface(opened.client, server, timeoutMs);
    } finally {
      await opened.close();
    }
  })();
  // Whichever loses the race still settles; its outcome is no longer anybody's.
  work.catch(() => undefined);

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the server declares, read over a connection already made. */
async function readSurface(client: Client, server: ConfiguredServer, timeoutMs: number): Promise<CapturedSurface> {
  const capabilities = client.getServerCapabilities();

  /*
   * Only ask for what the server declares. A server MUST declare a capability it serves, the
   * SDK returns an empty list for anything undeclared, and asking anyway costs a round trip
   * per server and emits a warning per call -- which, across a few hundred servers, buries
   * everything else.
   */
  const [tools, resources, resourceTemplates, prompts] = await Promise.all([
    capabilities?.tools ? listOrEmpty("tools/list", server.name, async () => listAllTools(client, timeoutMs)) : [],
    // Each list call is bounded by the server's timeout too. With none, the SDK's default
    // applied per page (60s, up to 64 pages), so one slow server could hold a run for an hour.
    capabilities?.resources ? listOrEmpty("resources/list", server.name, async () => (await client.listResources(undefined, { ...FRESH, timeout: timeoutMs })).resources) : [],
    capabilities?.resources
      ? listOrEmpty("resources/templates/list", server.name, async () => (await client.listResourceTemplates(undefined, { ...FRESH, timeout: timeoutMs })).resourceTemplates)
      : [],
    capabilities?.prompts ? listOrEmpty("prompts/list", server.name, async () => (await client.listPrompts(undefined, { ...FRESH, timeout: timeoutMs })).prompts) : [],
  ]);

  return {
    protocol: readProtocol(client),
    serverInfo: readServerInfo(client),
    capabilities: capabilities ? (toJson(capabilities) as JsonObject) : undefined,
    // Clients place this in the model's system prompt, so it is part of the capability surface.
    instructions: client.getInstructions(),
    tools,
    resources,
    resourceTemplates,
    prompts,
  };
}
