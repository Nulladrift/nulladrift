/**
 * Crawl state on disk.
 *
 * The pinned corpus is one ordinary `mcp.lock` per server, under `corpus/`; see `corpus.ts` for
 * why it is not one file. `history.json` carries what a lockfile deliberately does not:
 * timestamps, and per-server counters that turn a sequence of snapshots into a rate.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusStats } from "./registry";

export const HISTORY_FILE = "history.json";

/**
 * Failures in a row before a server is called gone rather than briefly unwell.
 *
 * One bad reading is a network. Three in a row, on a daily schedule, is a server that has moved
 * or retired, and the two belong in different rows of the coverage table: an eighth of the last
 * run was unreachable, and a single counter cannot say whether that is one outage or forty
 * corpses being re-dialled every day.
 */
export const PERSISTENT_FAILURE_RUNS = 3;

/**
 * Runs a pinned subject may be missing from the registry corpus before its snapshot is dropped.
 *
 * Not one: the registry pages, and a truncated or briefly broken walk would otherwise discard
 * baselines that took months to accumulate. A week of consecutive absences is a delisting.
 */
export const PRUNE_AFTER_ABSENT_RUNS = 7;

/**
 * What the collector records about a server, as a version. Raise it in the same change that makes
 * `buildLockedServer` record a field it did not, or normalize one differently.
 *
 * A baseline captured at an older revision is not compared: it is re-read and pinned again, and
 * the run counts it as re-baselined. Comparing it would report the instrument changing as the
 * servers changing. That is what happened on 12 November 2026: the corpus was seeded from a
 * reading taken before collector 0.8.0 began recording each tool's `execution`, the next run
 * compared the two, and 2,300 of 6,032 servers "drifted" in a day, 92% of the findings in a
 * sample being `execution` going from unstated to `forbidden`.
 *
 * 1: before collector 0.8.0. 2: 0.8.0 on, recording `execution` on tools.
 */
export const CAPTURE_REVISION = 2;

export type Outcome = "baseline" | "stable" | "drifted" | "rebaselined" | "auth-required" | "unreachable";

export interface ServerObservation {
  firstSeenAt: string;
  lastCheckedAt: string;
  /** The capture revision of the pinned baseline. Absent on history written before it existed: 1. */
  revision?: number;
  /**
   * Where the current like-for-like window starts, when a re-baseline restarted it. The rate
   * integrates over time spent comparing like with like, and the gap a re-baseline bridges is not
   * that. Absent means the window starts at `firstSeenAt`.
   */
  windowStart?: string;
  /** Days observed in windows a re-baseline closed. They still count; they just end. */
  priorObservedDays?: number;
  lastChangedAt?: string;
  /** Runs where a comparison was possible -- a baseline run is not one. */
  comparisons: number;
  driftEvents: number;
  protocol?: string;
}

/**
 * A run of consecutive failures, cleared by the next success.
 *
 * Kept apart from `servers` on purpose. `ServerObservation` dates the observation window that
 * `serverDays` integrates over, and a server nobody has ever captured must not widen it -- time
 * spent failing to reach something is not time spent watching it, and counting it would deflate
 * the headline rate with observations that never happened.
 */
export interface FailureStreak {
  consecutive: number;
  kind: "auth-required" | "unreachable";
  firstFailedAt: string;
  lastFailedAt: string;
}

export interface RunRecord {
  at: string;
  targets: number;
  /** `rebaselined` is absent on runs recorded before re-baselining existed. */
  outcomes: Record<Exclude<Outcome, "rebaselined">, number> & { rebaselined?: number };
  changeKinds: Record<string, number>;
  protocols: Record<string, number>;
  corpus: CorpusStats;
  /** Server names that drifted in this run, so a spike can be explained. */
  driftedServers: string[];
}

export interface History {
  version: 1;
  runs: RunRecord[];
  servers: Record<string, ServerObservation>;
  /** Live failure streaks by server name. Absent from the map means the last reading succeeded. */
  failures: Record<string, FailureStreak>;
  /** Consecutive runs a pinned subject has not appeared in the corpus at all. */
  absent: Record<string, number>;
}

export function emptyHistory(): History {
  return { version: 1, runs: [], servers: {}, failures: {}, absent: {} };
}

export async function readHistory(stateDir: string): Promise<History> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, HISTORY_FILE), "utf8")) as History;
    if (parsed.version !== 1) return emptyHistory();
    /*
     * Defaulted field by field rather than version-bumped. A bump would send `readHistory` down
     * the `emptyHistory()` path and discard every observation on the state branch, which is the
     * one thing here that cannot be regenerated -- months of elapsed time is the whole asset.
     */
    return { ...parsed, failures: parsed.failures ?? {}, absent: parsed.absent ?? {} };
  } catch {
    return emptyHistory();
  }
}

/** Keys sorted so the committed file diffs cleanly, same reasoning as the lockfile. */
function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key] as T]));
}

export async function writeHistory(stateDir: string, history: History): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const ordered: History = {
    ...history,
    servers: sortKeys(history.servers),
    failures: sortKeys(history.failures),
    absent: sortKeys(history.absent),
  };
  await writeFile(join(stateDir, HISTORY_FILE), `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}
