/** One pass over the corpus: capture every server, compare against the pinned snapshot. */
import { mkdir } from "node:fs/promises";
import { diffLockfiles } from "../diff";
import type { Change } from "../diff/types";
import { buildLockedServer } from "../lock/build";
import type { Lockfile, LockedMcpServer } from "../lock/types";
import { LOCKFILE_VERSION } from "../lock/types";
import { captureSurface } from "../mcp/capture";
import { isAuthFailure } from "../mcp/types";
import { discardFetch, runFetch } from "./sandbox";
import type { Corpus, CrawlTarget } from "./registry";
import type { FailureStreak, History, Outcome, RunRecord, ServerObservation } from "./state";
import { emptyHistory, PRUNE_AFTER_ABSENT_RUNS, readHistory, writeHistory } from "./state";
import { readCorpus, writeCorpus } from "./corpus";

export interface CrawlOptions {
  stateDir: string;
  corpus: Corpus;
  timeoutMs?: number;
  concurrency?: number;
  /** Minimum gap between starting requests. Hundreds of third-party hosts deserve a queue, not a flood. */
  delayMs?: number;
  /** Minimum gap between requests aimed at the same host. See `mapWithLimit`. */
  hostDelayMs?: number;
  now?: Date;
  onProgress?: (done: number, total: number, name: string, outcome: Outcome) => void;
}

export interface CrawlResult {
  run: RunRecord;
  history: History;
  /** Every change seen this pass, for the detailed section of the report. */
  changes: Change[];
  /** Servers this run had a baseline for, read from the state directory before it started. */
  baselines: number;
  /** Corpus files that could not be read, so those servers started over. Should be empty. */
  unreadable: string[];
  /** Subjects dropped from the corpus lock because the registry no longer lists them. */
  pruned: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The host a target is dialled at, or nothing for a stdio server, which contacts no one. */
function hostOf(target: CrawlTarget): string | undefined {
  if (target.transport.type === "stdio") return undefined;
  try {
    return new URL(target.transport.url).host;
  } catch {
    return undefined;
  }
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  delayMs: number,
  hostDelayMs: number,
  hostOfItem: (item: T) => string | undefined,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let earliestStart = 0;
  /*
   * The global clock caps what leaves this process; it says nothing about where any of it lands.
   * One operator hosting twenty of the servers in the corpus took twenty requests inside a
   * second while the aggregate rate looked polite, which is the operator's view of a flood.
   */
  const hostFreeAt = new Map<string, number>();

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        const item = items[index];
        if (index >= items.length || item === undefined) return;

        // A shared clock rather than a per-worker sleep: the point is to cap the rate at which
        // requests leave this process, not to slow each worker down independently.
        if (delayMs > 0 || hostDelayMs > 0) {
          const host = hostOfItem(item);
          const now = Date.now();
          const start = Math.max(now, earliestStart, host === undefined ? 0 : (hostFreeAt.get(host) ?? 0));
          earliestStart = start + delayMs;
          if (host !== undefined) hostFreeAt.set(host, start + hostDelayMs);
          if (start > now) await sleep(start - now);
        }
        results[index] = await worker(item);
      }
    }),
  );
  return results;
}

interface Captured {
  target: CrawlTarget;
  entry?: LockedMcpServer;
  failure?: "auth-required" | "unreachable";
}

/**
 * Every endpoint the entry advertises, in order, until one answers.
 *
 * A credential wall is not a reason to try the next one: it is a definitive answer about this
 * server -- it exists, it works, and it will not talk to us -- and re-dialling its other URLs
 * only hands the operator a second rejected request to log.
 */
async function captureAny(target: CrawlTarget, timeoutMs: number): Promise<Captured> {
  /*
   * A registry package is fetched first, with the network and none of its code, then run with
   * neither; see sandbox.ts. The volume it was fetched into goes either way.
   */
  if (target.fetch) {
    const fetched = await runFetch(target.fetch, Math.max(timeoutMs, 120_000));
    try {
      if (!fetched.ok) return { target, failure: "unreachable" };
      return await captureCandidates(target, timeoutMs);
    } finally {
      await discardFetch(target.fetch);
    }
  }
  return captureCandidates(target, timeoutMs);
}

async function captureCandidates(target: CrawlTarget, timeoutMs: number): Promise<Captured> {
  const candidates = [target.transport, ...(target.alternates ?? [])];

  for (const transport of candidates) {
    const attempt: CrawlTarget = { ...target, transport };
    try {
      const surface = await captureSurface(attempt, timeoutMs);
      return { target: attempt, entry: buildLockedServer(attempt, surface) };
    } catch (error) {
      if (isAuthFailure(error)) return { target: attempt, failure: "auth-required" };
    }
  }
  return { target, failure: "unreachable" };
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const { stateDir, corpus } = options;
  const now = options.now ?? new Date();
  const at = now.toISOString();

  await mkdir(stateDir, { recursive: true });
  /*
   * Read file by file. It used to be one lockfile read with `.catch(() => empty)`, so a state that
   * could not be read looked exactly like a first run -- which is what every run looked like for
   * a week while the state could not be saved. A file that cannot be read now costs that one
   * server its baseline, and the count is reported.
   */
  const stored = await readCorpus(stateDir);
  const previous: Lockfile = { lockfileVersion: LOCKFILE_VERSION, subjects: stored.subjects };
  const history = await readHistory(stateDir).catch(() => emptyHistory());

  let done = 0;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const captured = await mapWithLimit(
    corpus.targets,
    options.concurrency ?? 8,
    options.delayMs ?? 50,
    options.hostDelayMs ?? 1_000,
    hostOf,
    async (target): Promise<Captured> => {
      const result = await captureAny(target, timeoutMs);
      const outcome: Outcome = result.failure ?? (previous.subjects[target.name] ? "stable" : "baseline");
      options.onProgress?.(++done, corpus.targets.length, target.name, outcome);
      return result;
    },
  );

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
      /*
       * A streak, not a tally. Without the run of consecutive failures a server that retired
       * months ago is indistinguishable from one that blinked once, and both quietly depress
       * the coverage the report publishes.
       */
      const prior = history.failures[name];
      const streak: FailureStreak =
        prior === undefined || prior.kind !== result.failure
          ? { consecutive: 1, kind: result.failure, firstFailedAt: at, lastFailedAt: at }
          : { ...prior, consecutive: prior.consecutive + 1, lastFailedAt: at };
      history.failures[name] = streak;
      continue;
    }
    delete history.failures[name];

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

  /*
   * Servers we could not reach keep their previous entry, so a transient outage does not erase a
   * baseline that took weeks to accumulate. A server the registry no longer lists is a different
   * case: it will never be dialled again, so holding its snapshot forever is only a corpus lock
   * that grows without bound. It takes a week of consecutive absences, because one short walk is
   * not evidence of a delisting -- and on a truncated walk, which is missing targets for reasons
   * that have nothing to do with the registry's contents, nothing is pruned at all.
   */
  const inCorpus = new Set(corpus.targets.map((target) => target.name));
  const subjects: Record<string, LockedMcpServer> = { ...previous.subjects, ...fresh };
  const pruned: string[] = [];

  for (const name of Object.keys(subjects)) {
    if (inCorpus.has(name)) {
      delete history.absent[name];
      continue;
    }
    if (corpus.stats.truncated) continue;

    const absences = (history.absent[name] ?? 0) + 1;
    if (absences < PRUNE_AFTER_ABSENT_RUNS) {
      history.absent[name] = absences;
      continue;
    }
    // The observation in `history.servers` stays: it is the record of what was measured while
    // the server existed, and the all-time rate is computed from it.
    delete history.absent[name];
    delete history.failures[name];
    delete subjects[name];
    pruned.push(name);
  }

  await writeCorpus(stateDir, subjects);
  await writeHistory(stateDir, history);

  return { run, history, changes, pruned: pruned.sort(), baselines: Object.keys(stored.subjects).length, unreadable: stored.unreadable };
}
