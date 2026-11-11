/** Asking a connected server for everything it exposes. */
import type { Client, Tool } from "@modelcontextprotocol/client";
import type { ConfiguredServer } from "../config/types";
import type { JsonObject, LockedProtocol, LockedServerInfo } from "../lock/types";
import { toJson } from "../lock/canonical";
import { lockIcons } from "../lock/build";
import { connect, DEFAULT_TIMEOUT_MS, type Connection } from "./connect";
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
async function listAllTools(client: Client, timeoutMs: number): Promise<{ tools: Tool[]; partial?: string }> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = (await client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, { timeout: timeoutMs })) as {
      tools: Tool[];
      nextCursor?: string;
    };
    // One at a time: spreading a page of 150,000 tools into `push` overflowed the call stack.
    for (const tool of result.tools) tools.push(tool);
    cursor = result.nextCursor;
    if (cursor === undefined) return { tools };
    /*
     * A listing that does not end is a partial surface, not a missing one. These used to fail the
     * server outright; now the pages that were read are pinned and the reading says it is
     * incomplete, which `check` treats as an unfinished audit unless told otherwise. Pinning them
     * silently as the whole would be the false clean this product exists to refuse.
     */
    if (cursors.has(cursor)) return { tools, partial: `tools/list repeated a page cursor after ${page + 1} page(s), so its listing never ends; the pages before the repeat were read` };
    cursors.add(cursor);
  }
  return { tools, partial: `tools/list did not end within ${MAX_LIST_PAGES} pages; the first ${MAX_LIST_PAGES} were read` };
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
    icons: lockIcons(info.icons),
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
      return await readSurface(opened, server, timeoutMs);
    } catch (error) {
      // The guard stopped reading, and the request it was serving failed for that reason.
      const refused = opened.refused();
      if (refused !== undefined) throw new UnreachableServerError(server.name, refused, error);
      throw error;
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

/** How many times the lists are read when the server says one changed while they were being read. */
const LIST_PASSES = 2;

/**
 * What the server declares, read over a connection already made.
 *
 * A `list_changed` notification arriving mid-read means the lists just read may not be the ones
 * the server now has, so they are read again. A server announcing a change once -- at start-up,
 * say, after it loads its plugins -- is read cleanly the second time. One that says so on every
 * pass is a surface that would not hold still to be read, and the reading says so.
 */
async function readSurface(connection: Connection, server: ConfiguredServer, timeoutMs: number): Promise<CapturedSurface> {
  for (let pass = 1; ; pass += 1) {
    connection.watchChanges();
    const surface = await readLists(connection.client, server, timeoutMs);
    const moved = connection.changed();
    if (moved.length === 0) return surface;
    if (pass >= LIST_PASSES) {
      const reasons = [
        ...(surface.coverage?.reasons ?? []),
        `the server said its ${moved.join(" and ")} changed while being read, on ${LIST_PASSES} passes running, so no read is known to be current`,
      ];
      return { ...surface, coverage: { complete: false, reasons } };
    }
  }
}

async function readLists(client: Client, server: ConfiguredServer, timeoutMs: number): Promise<CapturedSurface> {
  const capabilities = client.getServerCapabilities();

  /*
   * Only ask for what the server declares. A server MUST declare a capability it serves, the
   * SDK returns an empty list for anything undeclared, and asking anyway costs a round trip
   * per server and emits a warning per call -- which, across a few hundred servers, buries
   * everything else.
   */
  let toolsPartial: string | undefined;
  const [tools, resources, resourceTemplates, prompts] = await Promise.all([
    capabilities?.tools
      ? listOrEmpty("tools/list", server.name, async () => {
          const listed = await listAllTools(client, timeoutMs);
          toolsPartial = listed.partial;
          return listed.tools;
        })
      : [],
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
    ...(toolsPartial ? { coverage: { complete: false as const, reasons: [toolsPartial] } } : {}),
  };
}
