/** One pass over the corpus: capture every server, compare against the pinned snapshot. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConfiguredServer } from "../config/types";
import { diffLockfiles } from "../diff";
import type { Change } from "../diff/types";
import { buildLockedServer } from "../lock/build";
import { readLockfile, writeLockfile } from "../lock/io";
import type { Lockfile, LockedMcpServer } from "../lock/types";
import { LOCKFILE_VERSION } from "../lock/types";
import { VERSION } from "../lib/version";
import { captureSurface } from "../mcp/capture";
import { isAuthFailure } from "../mcp/types";
import type { Corpus } from "./registry";
import type { History, Outcome, RunRecord, ServerObservation } from "./state";
import { CORPUS_LOCK, emptyHistory, readHistory, writeHistory } from "./state";

export interface CrawlOptions {
  stateDir: string;
  corpus: Corpus;
  timeoutMs?: number;
  concurrency?: number;
  /** Minimum gap between starting requests. Hundreds of third-party hosts deserve a queue, not a flood. */
  delayMs?: number;
  now?: Date;
  onProgress?: (done: number, total: number, name: string, outcome: Outcome) => void;
}

export interface CrawlResult {
  run: RunRecord;
  history: History;
  /** Every change seen this pass, for the detailed section of the report. */
  changes: Change[];
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function mapWithLimit<T, R>(items: T[], limit: number, delayMs: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let earliestStart = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        const item = items[index];
        if (index >= items.length || item === undefined) return;

        // A shared clock rather than a per-worker sleep: the point is to cap the rate at which
        // requests leave this process, not to slow each worker down independently.
        if (delayMs > 0) {
          const now = Date.now();
          const start = Math.max(now, earliestStart);
          earliestStart = start + delayMs;
          if (start > now) await sleep(start - now);
        }
        results[index] = await worker(item);
      }
    }),
  );
  return results;
}

interface Captured {
  target: ConfiguredServer;
  entry?: LockedMcpServer;
  failure?: "auth-required" | "unreachable";
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const { stateDir, corpus } = options;
  const now = options.now ?? new Date();
  const at = now.toISOString();

  await mkdir(stateDir, { recursive: true });
  const lockPath = join(stateDir, CORPUS_LOCK);
  const previous: Lockfile = await readLockfile(lockPath).catch(() => ({
    lockfileVersion: LOCKFILE_VERSION,
    generatedBy: `nulladrift@${VERSION}`,
    subjects: {},
  }));
  const history = await readHistory(stateDir).catch(() => emptyHistory());

  let done = 0;
  const captured = await mapWithLimit(corpus.targets, options.concurrency ?? 8, options.delayMs ?? 50, async (target): Promise<Captured> => {
    try {
      const surface = await captureSurface(target, options.timeoutMs ?? 20_000);
      const result: Captured = { target, entry: buildLockedServer(target, surface) };
      options.onProgress?.(++done, corpus.targets.length, target.name, previous.subjects[target.name] ? "stable" : "baseline");
      return result;
    } catch (error) {
      const failure = isAuthFailure(error) ? "auth-required" : "unreachable";
      options.onProgress?.(++done, corpus.targets.length, target.name, failure);
      return { target, failure };
    }
  });

  /*
   * Only servers captured on this pass are diffed. A server we could not reach is absent from
   * the fresh snapshot, and diffing the whole corpus would report it as removed -- drift that
   * says nothing about the server and everything about the network.
   */
  const fresh: Record<string, LockedMcpServer> = {};
  const comparable: Record<string, LockedMcpServer> = {};
  for (const result of captured) {
    if (!result.entry) continue;
    fresh[result.target.name] = result.entry;
    const prior = previous.subjects[result.target.name];
    if (prior) comparable[result.target.name] = prior;
  }

  const changes = diffLockfiles(
    { lockfileVersion: LOCKFILE_VERSION, subjects: comparable },
    { lockfileVersion: LOCKFILE_VERSION, subjects: Object.fromEntries(Object.keys(comparable).map((name) => [name, fresh[name] as LockedMcpServer])) },
  );
  const driftedServers = [...new Set(changes.map((change) => change.server))].sort();

  const outcomes: Record<Outcome, number> = { baseline: 0, stable: 0, drifted: 0, "auth-required": 0, unreachable: 0 };
  const protocols: Record<string, number> = {};
  const changeKinds: Record<string, number> = {};
  for (const change of changes) changeKinds[change.kind] = (changeKinds[change.kind] ?? 0) + 1;

  for (const result of captured) {
    const name = result.target.name;
    if (result.failure) {
      outcomes[result.failure] += 1;
      continue;
    }
    const entry = result.entry as LockedMcpServer;
    const revision = `${entry.protocol.era}/${entry.protocol.version}`;
    protocols[revision] = (protocols[revision] ?? 0) + 1;

    const isBaseline = previous.subjects[name] === undefined;
    const drifted = driftedServers.includes(name);
    outcomes[isBaseline ? "baseline" : drifted ? "drifted" : "stable"] += 1;

    const observation: ServerObservation = history.servers[name] ?? { firstSeenAt: at, lastCheckedAt: at, comparisons: 0, driftEvents: 0 };
    observation.lastCheckedAt = at;
    observation.protocol = revision;
    if (!isBaseline) observation.comparisons += 1;
    if (drifted) {
      observation.driftEvents += 1;
      observation.lastChangedAt = at;
    }
    history.servers[name] = observation;
  }

  const run: RunRecord = { at, targets: corpus.targets.length, outcomes, changeKinds, protocols, corpus: corpus.stats, driftedServers };
  history.runs.push(run);

  // Servers we could not reach keep their previous entry, so a transient outage does not erase
  // a baseline that took weeks to accumulate.
  await writeLockfile(lockPath, {
    lockfileVersion: LOCKFILE_VERSION,
    generatedBy: `nulladrift@${VERSION}`,
    subjects: { ...previous.subjects, ...fresh },
  });
  await writeHistory(stateDir, history);

  return { run, history, changes };
}
