/**
 * The corpus: public servers from the official MCP registry.
 *
 * Only remote (Streamable HTTP / SSE) servers are taken. The registry's other entries are npm or
 * PyPI packages launched over stdio, and auditing one means executing a third-party package.
 * Running hundreds of those to measure supply-chain risk needs a disposable sandbox with no
 * credentials and no egress, which is infrastructure this crawl does not have. The report records
 * how many entries were skipped for that reason so the coverage gap is visible rather than
 * implied.
 */
import { z } from "zod";
import type { ConfiguredServer, ConfiguredTransport } from "../config/types";
import { USER_AGENT } from "../lib/version";
import type { SandboxFetch, SandboxOptions } from "./sandbox";
import { sandboxedStdio } from "./sandbox";

const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const PAGE_SIZE = 100;

/**
 * The registry held over 12,000 entries when this was written and grows; a full walk is ~120
 * requests and several minutes. The cap is a backstop against a cursor that never terminates,
 * not a policy -- when it is hit the caller is told, rather than quietly handed a partial
 * corpus it would mistake for the whole registry.
 */
const DEFAULT_MAX_PAGES = 400;

const remoteSchema = z.looseObject({
  type: z.string(),
  url: z.string(),
});

const entrySchema = z.looseObject({
  server: z.looseObject({
    name: z.string(),
    title: z.string().optional(),
    version: z.string().optional(),
    remotes: z.array(remoteSchema).optional(),
  packages: z
      .array(z.looseObject({ registryType: z.string().optional(), identifier: z.string().optional(), version: z.string().optional() }))
      .optional(),
  }),
  _meta: z
    .looseObject({
      "io.modelcontextprotocol.registry/official": z
        .looseObject({ status: z.string().optional(), isLatest: z.boolean().optional() })
        .optional(),
    })
    .optional(),
});

const pageSchema = z.looseObject({
  servers: z.array(entrySchema),
  metadata: z.looseObject({ nextCursor: z.string().optional(), count: z.number().optional() }).optional(),
});

export interface CorpusStats {
  /** Registry entries marked as the latest active version of their name. */
  latest: number;
  /** Of those, the ones reachable without executing anything. */
  remote: number;
  /** Of those, the ones that would require running a third-party package. */
  stdioOnly: number;
  /** stdio entries actually taken, because a sandbox was available. */
  stdioSandboxed: number;
  /** stdio entries a sandbox could not express (a registry we do not support). */
  stdioUnsupported: number;
  /**
   * True when paging stopped at the cap rather than at the end of the registry.
   *
   * It belongs in the stats rather than beside them because the stats are what the run record
   * keeps. A truncated pass yields fewer targets, and without this in the history a short run
   * six months from now reads as an ecosystem that shrank.
   */
  truncated: boolean;
}

/** A registry entry may advertise several endpoints; the extras are tried only if the first fails. */
export interface CrawlTarget extends ConfiguredServer {
  alternates?: ConfiguredTransport[];
  /** A registry package: fetched into a volume before `transport` can start. See sandbox.ts. */
  fetch?: SandboxFetch;
}

export interface Corpus {
  targets: CrawlTarget[];
  stats: CorpusStats;
}

type Remote = { type: string; url: string };

function toTransport(remote: Remote): ConfiguredTransport {
  return { type: remote.type === "sse" ? "sse" : "http", url: remote.url, headers: {} };
}

/**
 * Every endpoint the entry advertises, Streamable HTTP first.
 *
 * `remotes[0]` is whatever order the publisher wrote them in. A server that lists its deprecated
 * SSE endpoint first and no longer answers there counted as unreachable while the working HTTP
 * endpoint sat untouched in the same entry -- an outage invented by the reader, which then
 * depressed the coverage figure this report publishes.
 */
function toTarget(name: string, remotes: Remote[]): CrawlTarget {
  const ordered = [...remotes].sort((a, b) => Number(a.type === "sse") - Number(b.type === "sse"));
  const [first, ...rest] = ordered as [Remote, ...Remote[]];
  return {
    name,
    source: { client: "manual", file: "registry.modelcontextprotocol.io" },
    transport: toTransport(first),
    ...(rest.length > 0 ? { alternates: rest.map(toTransport) } : {}),
  };
}

export interface FetchCorpusOptions {
  limit?: number;
  timeoutMs?: number;
  /** Run registry packages in a container to read their tool list. See sandbox.ts. */
  includeStdio?: boolean;
  sandbox?: SandboxOptions;
  maxPages?: number;
  /** Called after each page. Paging the whole registry takes minutes; silence reads as a hang. */
  onPage?: (progress: { pages: number; entries: number; targets: number }) => void;
}

export async function fetchCorpus(options: FetchCorpusOptions = {}): Promise<Corpus> {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const targets: CrawlTarget[] = [];
  const seen = new Set<string>();
  const stats: CorpusStats = { latest: 0, remote: 0, stdioOnly: 0, stdioSandboxed: 0, stdioUnsupported: 0, truncated: false };

  let cursor: string | undefined;
  let pages = 0;
  let entries = 0;
  let truncated = false;
  // A cursor that repeats means the registry is not advancing; without this the loop never ends.
  const seenCursors = new Set<string>();

  do {
    const url = new URL(REGISTRY_URL);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      // Identified, so an operator reading their logs can find out what this is. See USER_AGENT.
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`registry ${url.pathname} → ${response.status}`);

    const page = pageSchema.parse(await response.json());
    for (const entry of page.servers) {
      const official = entry._meta?.["io.modelcontextprotocol.registry/official"];
      // The registry keeps every published version; only the current one is a live target.
      if (official?.isLatest !== true || (official.status !== undefined && official.status !== "active")) continue;
      stats.latest += 1;

      const remotes = entry.server.remotes ?? [];
      if (remotes.length === 0) {
        const pkg = entry.server.packages?.[0];
        if (pkg === undefined) continue;
        stats.stdioOnly += 1;

        /*
         * Classified before the `--include-stdio` gate rather than after it. The check used to
         * sit below, so a default run always left `stdioUnsupported` at 0 -- a figure that reads
         * as "every stdio entry could have been measured" when it means "none were looked at".
         * Deciding here costs nothing and says what the npm-only sandbox actually excludes.
         */
        const sandboxed = sandboxedStdio(pkg, options.sandbox);
        if (!sandboxed.ok) {
          stats.stdioUnsupported += 1;
          continue;
        }
        if (options.includeStdio !== true) continue;
        if (seen.has(entry.server.name) || targets.length >= limit) continue;
        seen.add(entry.server.name);
        stats.stdioSandboxed += 1;
        targets.push({ name: entry.server.name, source: { client: "manual", file: "registry.modelcontextprotocol.io" }, transport: sandboxed.transport, fetch: sandboxed.fetch });
        continue;
      }
      stats.remote += 1;

      if (seen.has(entry.server.name) || targets.length >= limit) continue;
      seen.add(entry.server.name);
      targets.push(toTarget(entry.server.name, remotes));
    }

    pages += 1;
    entries += page.servers.length;
    options.onPage?.({ pages, entries, targets: targets.length });

    cursor = page.metadata?.nextCursor;
    if (cursor !== undefined && seenCursors.has(cursor)) {
      truncated = true;
      break;
    }
    if (cursor !== undefined) seenCursors.add(cursor);
    if (pages >= (options.maxPages ?? DEFAULT_MAX_PAGES)) {
      truncated = cursor !== undefined;
      break;
    }
  } while (cursor !== undefined && targets.length < limit);

  stats.truncated = truncated;
  return { targets, stats };
}
