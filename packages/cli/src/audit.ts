/** Shared orchestration: discover every configured server, talk to each one, build a lockfile. */
import type { Discovery } from "./config/discover";
import { discoverServers } from "./config/discover";
import { buildLockedServer } from "./lock/build";
import { carriedForward, referenceOf, resolveReference } from "./lock/provenance";
import { fetchedElsewhere } from "./lock/source";
import type { Lockfile, LockedMcpServer, LockedProvenance, LockPolicy } from "./lock/types";
import type { ConfiguredServer } from "./config/types";
import { LOCKFILE_VERSION } from "./lock/types";
import { captureSurface } from "./mcp/capture";
import { DEFAULT_TIMEOUT_MS } from "./mcp/connect";
import { UnreachableServerError, authFailureKind } from "./mcp/types";
import { VERSION } from "./lib/version";
import type { Unreachable } from "./report/types";

export interface CaptureOptions {
  projectRoot: string;
  configFiles?: string[];
  timeoutMs?: number;
  /** Stdio servers are child processes; a few at a time keeps a large config from thrashing. */
  concurrency?: number;
  policy?: LockPolicy;
  /**
   * The lock this run will be compared against or written over, when there is one.
   *
   * Used for one thing: keeping an artifact pin that this run could not re-establish, when the
   * configuration asks for exactly the version that was pinned. See `carriedForward`.
   */
  previous?: Lockfile;
  /** False skips resolving what each server runs. An air-gapped run, or somebody who opted out. */
  provenance?: boolean;
  /** Also read user-level client configs. Off: the lock is the project's, and it is committed. */
  userConfigs?: boolean;
  onServerDone?: (name: string, outcome: "captured" | "failed") => void;
}

export interface CaptureResult {
  lock: Lockfile;
  unreachable: Unreachable[];
  discovery: Discovery;
  /**
   * Servers whose artifact could not be established on this run.
   *
   * Not unreachable: the server answered, and its surface was compared as normal. What is
   * missing is the check of the code behind it, and saying so is the difference between "the
   * artifact did not change" and "nobody could look".
   */
  unverified: string[];
}

/**
 * What a captured server runs, and whether that could be established this time.
 *
 * Remote servers have no artifact this tool can see, and an invocation that cannot be read with
 * confidence has none either; both are simply absent, not unverified. Unverified is reserved for
 * the case where there was something to check and the check did not happen.
 */
async function provenanceOf(
  server: ConfiguredServer,
  options: CaptureOptions,
): Promise<{ provenance?: LockedProvenance; unverified: boolean }> {
  if (server.transport.type !== "stdio") return { unverified: false };
  const reference = referenceOf(server.transport, options.projectRoot);
  if (!reference) return { unverified: false };

  /*
   * A launcher that fetches from another registry, another index or a local install runs code the
   * registry's answer does not describe. Neither pinned nor carried forward: the previous pin was
   * the registry's too, and keeping it would say the same thing about the same code.
   */
  if (fetchedElsewhere(server.transport, reference, { projectRoot: options.projectRoot })) return { unverified: true };

  const previous = options.previous?.subjects[server.name]?.provenance;
  if (options.provenance === false) {
    const kept = carriedForward(previous, reference);
    return { ...(kept ? { provenance: kept } : {}), unverified: true };
  }

  const resolved = await resolveReference(reference, { timeoutMs: options.timeoutMs });
  if (resolved) return { provenance: resolved, unverified: false };
  const kept = carriedForward(previous, reference);
  return { ...(kept ? { provenance: kept } : {}), unverified: true };
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
  const discovery = await discoverServers(options.projectRoot, options.configFiles, { userConfigs: options.userConfigs === true });

  const captured = await mapWithLimit(discovery.servers, options.concurrency ?? 4, async (server) => {
    try {
      /*
       * What the server runs is read before it runs. Hashed after, a local file could put the
       * approved bytes back over itself once loaded, and the lock pinned the file it no longer was.
       */
      const { provenance, unverified } = await provenanceOf(server, options);
      const surface = await captureSurface(server, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const entry = buildLockedServer(server, surface, options.policy);
      options.onServerDone?.(server.name, "captured");
      return { name: server.name, entry: provenance ? { ...entry, provenance } : entry, unverified };
    } catch (error) {
      options.onServerDone?.(server.name, "failed");
      const reason = error instanceof UnreachableServerError ? error.message : (error as Error).message;
      const kind = authFailureKind(error) ?? "unreachable";
      return { name: server.name, failure: { server: server.name, reason, kind } satisfies Unreachable };
    }
  });

  const subjects: Record<string, LockedMcpServer> = {};
  const unreachable: Unreachable[] = [];
  const unverified: string[] = [];
  for (const result of captured) {
    if ("entry" in result && result.entry) {
      subjects[result.name] = result.entry;
      if (result.unverified) unverified.push(result.name);
    } else if ("failure" in result && result.failure) unreachable.push(result.failure);
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
    unverified: unverified.sort(),
  };
}
