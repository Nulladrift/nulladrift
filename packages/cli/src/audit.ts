/** Shared orchestration: discover every configured server, talk to each one, build a lockfile. */
import type { Discovery } from "./config/discover";
import { discoverServers } from "./config/discover";
import { buildLockedServer } from "./lock/build";
import type { Lockfile, LockedMcpServer, LockPolicy } from "./lock/types";
import { LOCKFILE_VERSION } from "./lock/types";
import { captureSurface } from "./mcp/capture";
import { DEFAULT_TIMEOUT_MS } from "./mcp/connect";
import { isAuthFailure, UnreachableServerError } from "./mcp/types";
import { VERSION } from "./lib/version";
import type { Unreachable } from "./report/types";

export interface CaptureOptions {
  projectRoot: string;
  configFiles?: string[];
  timeoutMs?: number;
  /** Stdio servers are child processes; a few at a time keeps a large config from thrashing. */
  concurrency?: number;
  policy?: LockPolicy;
  onServerDone?: (name: string, outcome: "captured" | "failed") => void;
}

export interface CaptureResult {
  lock: Lockfile;
  unreachable: Unreachable[];
  discovery: Discovery;
}

async function mapWithLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function captureAll(options: CaptureOptions): Promise<CaptureResult> {
  const discovery = await discoverServers(options.projectRoot, options.configFiles);

  const captured = await mapWithLimit(discovery.servers, options.concurrency ?? 4, async (server) => {
    try {
      const surface = await captureSurface(server, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      options.onServerDone?.(server.name, "captured");
      return { name: server.name, entry: buildLockedServer(server, surface, options.policy) };
    } catch (error) {
      options.onServerDone?.(server.name, "failed");
      const reason = error instanceof UnreachableServerError ? error.message : (error as Error).message;
      const kind = isAuthFailure(error) ? "auth" : "unreachable";
      return { name: server.name, failure: { server: server.name, reason, kind } satisfies Unreachable };
    }
  });

  const subjects: Record<string, LockedMcpServer> = {};
  const unreachable: Unreachable[] = [];
  for (const result of captured) {
    if ("entry" in result && result.entry) subjects[result.name] = result.entry;
    else if ("failure" in result && result.failure) unreachable.push(result.failure);
  }

  // Configs we understood but cannot audit (unsupported transport, unresolvable placeholder) are
  // unreachable too: the audit is incomplete either way, and CI should treat them the same.
  for (const skipped of discovery.skipped) {
    unreachable.push({ server: skipped.serverName, reason: skipped.message, kind: "unreachable" });
  }
  // A --config file we could not make sense of is not "no servers"; it is an unfinished audit.
  for (const problem of discovery.problems) {
    unreachable.push({ server: problem.file, reason: problem.reason, kind: "unreachable" });
  }

  return {
    lock: {
      lockfileVersion: LOCKFILE_VERSION,
      generatedBy: `nulladrift@${VERSION}`,
      policy: options.policy,
      subjects,
    },
    unreachable,
    discovery,
  };
}
