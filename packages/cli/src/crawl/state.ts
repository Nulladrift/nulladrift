/**
 * Crawl state on disk.
 *
 * The pinned corpus is stored as an ordinary `mcp.lock` holding every server, which is the same
 * format and the same serializer the product ships -- the crawl is the largest thing that
 * exercises it. `history.json` carries what a lockfile deliberately does not: timestamps, and
 * per-server counters that turn a sequence of snapshots into a rate.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusStats } from "./registry";

export const CORPUS_LOCK = "corpus.lock";
export const HISTORY_FILE = "history.json";

export type Outcome = "baseline" | "stable" | "drifted" | "auth-required" | "unreachable";

export interface ServerObservation {
  firstSeenAt: string;
  lastCheckedAt: string;
  lastChangedAt?: string;
  /** Runs where a comparison was possible -- a baseline run is not one. */
  comparisons: number;
  driftEvents: number;
  protocol?: string;
}

export interface RunRecord {
  at: string;
  targets: number;
  outcomes: Record<Outcome, number>;
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
}

export function emptyHistory(): History {
  return { version: 1, runs: [], servers: {} };
}

export async function readHistory(stateDir: string): Promise<History> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, HISTORY_FILE), "utf8")) as History;
    return parsed.version === 1 ? parsed : emptyHistory();
  } catch {
    return emptyHistory();
  }
}

export async function writeHistory(stateDir: string, history: History): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  // Server keys sorted so the file diffs cleanly, same reasoning as the lockfile.
  const servers = Object.fromEntries(Object.keys(history.servers).sort().map((name) => [name, history.servers[name]]));
  await writeFile(join(stateDir, HISTORY_FILE), `${JSON.stringify({ ...history, servers }, null, 2)}\n`, "utf8");
}
