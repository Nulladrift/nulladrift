/** Shared orchestration: discover every configured server, talk to each one, build a lockfile. */
import type { Discovery } from "./config/discover";
import { discoverServers } from "./config/discover";
import { isCredentialName, SEVERITY, sortChanges } from "@nulladrift/core";
import { diffLockfiles } from "./diff";
import type { Change } from "./diff/types";
import { buildLockedServer, lockTransport } from "./lock/build";
import { carriedForward, launchPinned, referenceOf, resolveReference } from "./lock/provenance";
import { fetchedElsewhere } from "./lock/source";
import type { Lockfile, LockedMcpServer, LockedProvenance, LockedUnaudited, LockPolicy } from "./lock/types";
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
  /**
   * Servers whose pinned artifact this run found configured to come from somewhere else: a
   * registry, an index or a local install the pin does not describe. A file in the repository
   * is enough to do that, so it is drift, not a gap in the record; see `compareWithLock`.
   */
  displaced: Array<{ server: string; previous: LockedProvenance; why: string }>;
  /**
   * Configured servers this run could not audit, by name, with how each is reached where that
   * could be read. Excludes config files it could not read, and names defined two ways, which no
   * acknowledgement covers.
   */
  unaudited: Record<string, LockedUnaudited>;
  /** Names defined two ways; reported as unreachable, never acknowledged. */
  conflicted: string[];
  /**
   * Servers read, but not in full: the listing did not end, or would not hold still to be read.
   * Pinned as far as they were read, and an unfinished audit unless `--allow-partial`.
   */
  partial: Array<{ server: string; reasons: string[] }>;
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
): Promise<{ provenance?: LockedProvenance; unverified: boolean; displaced?: { previous: LockedProvenance; why: string } }> {
  if (server.transport.type !== "stdio") return { unverified: false };
  const reference = referenceOf(server.transport, options.projectRoot);
  if (!reference) return { unverified: false };
  const previous = options.previous?.subjects[server.name]?.provenance;

  /*
   * A launcher that fetches from another registry, another index or a local install runs code the
   * registry's answer does not describe. Neither pinned nor carried forward: the previous pin was
   * the registry's too, and keeping it would say the same thing about the same code.
   *
   * Where there was a pin, that is a change and not a gap. One `.npmrc` in a pull request turned
   * a substituted package from a failing `server.artifact.substituted` into "could not
   * establish" and an exit 0, and the author of the pull request chose which.
   */
  const elsewhere = fetchedElsewhere(server.transport, reference, { projectRoot: options.projectRoot });
  if (elsewhere) return { unverified: true, ...(previous ? { displaced: { previous, why: elsewhere } } : {}) };

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
      const { provenance, unverified, displaced } = await provenanceOf(server, options);
      // An image runs by the digest it was pinned at; see launchPinned. The lock keeps the config as written.
      const pinned = server.transport.type === "stdio" ? launchPinned(server.transport, provenance) : undefined;
      const surface = await captureSurface(pinned ? { ...server, transport: pinned } : server, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const entry = buildLockedServer(server, surface, options.policy);
      options.onServerDone?.(server.name, "captured");
      return { name: server.name, entry: provenance ? { ...entry, provenance } : entry, unverified, displaced };
    } catch (error) {
      options.onServerDone?.(server.name, "failed");
      const reason = withoutSecrets(error instanceof UnreachableServerError ? error.message : (error as Error).message, server);
      const kind = authFailureKind(error) ?? "unreachable";
      return { name: server.name, failure: { server: server.name, reason, kind } satisfies Unreachable };
    }
  });

  const subjects: Record<string, LockedMcpServer> = {};
  const unreachable: Unreachable[] = [];
  const unverified: string[] = [];
  const displaced: CaptureResult["displaced"] = [];
  const unaudited: Record<string, LockedUnaudited> = {};
  const configured = new Map(discovery.servers.map((server) => [server.name, server]));
  for (const result of captured) {
    if ("entry" in result && result.entry) {
      subjects[result.name] = result.entry;
      if (result.unverified) unverified.push(result.name);
      if (result.displaced) displaced.push({ server: result.name, ...result.displaced });
    } else if ("failure" in result && result.failure) {
      unreachable.push(result.failure);
      const server = configured.get(result.name);
      unaudited[result.name] = server ? { transport: lockTransport(server) } : {};
    }
  }

  // Configs we understood but cannot audit (unsupported transport, unresolvable placeholder) are
  // unreachable too: the audit is incomplete either way, and CI should treat them the same.
  for (const skipped of discovery.skipped) {
    unreachable.push({ server: skipped.serverName, reason: skipped.message, kind: "unreachable" });
    unaudited[skipped.serverName] = {};
  }
  // A name the project defines two ways is audited under neither until it says which it means.
  for (const conflict of discovery.conflicts) {
    unreachable.push({
      server: conflict.name,
      reason: `defined differently in ${conflict.definitions.map((definition) => definition.file).join(" and ")}. Each client runs the one in its own file, so auditing one of them would vouch for the others. Give them different names, or make them the same.`,
      kind: "unreachable",
    });
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
    displaced,
    unaudited,
    conflicted: discovery.conflicts.map((conflict) => conflict.name),
    partial: Object.entries(subjects)
      .filter(([, entry]) => entry.coverage !== undefined)
      .map(([server, entry]) => ({ server, reasons: entry.coverage!.reasons }))
      .sort((a, b) => a.server.localeCompare(b.server)),
  };
}

/** Whether the lock already agreed to leave this server unaudited, reached the way it is now. */
function acknowledged(committed: Lockfile, name: string, now: LockedUnaudited): boolean {
  const agreed = committed.unaudited?.[name];
  return agreed !== undefined && JSON.stringify(agreed.transport ?? null) === JSON.stringify(now.transport ?? null);
}

/**
 * What changed against the committed lock: the diff, and what only this run can know.
 *
 * - A pin displaced: the lock says what registry artifact runs, and the configuration now fetches
 *   it from somewhere else. Reported as `server.artifact.changed`, so it fails like any change to
 *   what runs and is accepted, deliberately, like one.
 * - A server added that could not be audited. The diff only sees servers that were captured, so
 *   under `--allow-unreachable` a new server that refused the auditor -- one that exits when the
 *   client says it is nulladrift -- never appeared at all, and the build passed with it in it.
 */
export function compareWithLock(committed: Lockfile, result: CaptureResult): Change[] {
  const changes = diffLockfiles(committed, result.lock);
  for (const moved of result.displaced) {
    const was = `${moved.previous.name}${moved.previous.version ? `@${moved.previous.version}` : ""}`;
    changes.push({
      kind: "server.artifact.changed",
      severity: SEVERITY["server.artifact.changed"],
      server: moved.server,
      summary: `${was} was pinned from its registry, and now ${moved.why}: what runs is not what was pinned, and nothing here can check it`,
      before: moved.previous,
    });
  }
  const failed = new Map(result.unreachable.map((failure) => [failure.server, failure.reason]));
  for (const [name, now] of Object.entries(result.unaudited)) {
    if (committed.subjects[name] !== undefined || acknowledged(committed, name, now)) continue;
    changes.push({
      kind: "server.added",
      severity: SEVERITY["server.added"],
      server: name,
      summary: `${committed.unaudited?.[name] ? "a server left unaudited is now reached differently, and" : "new server, which"} could not be audited: ${failed.get(name) ?? "it did not answer"}`,
    });
  }
  for (const name of result.conflicted) {
    if (committed.subjects[name] !== undefined) continue;
    changes.push({
      kind: "server.added",
      severity: SEVERITY["server.added"],
      server: name,
      summary: `new server, defined differently in two config files: ${failed.get(name) ?? ""}`,
    });
  }
  return sortChanges(changes);
}

/**
 * The acknowledgements to write: every server this run could not audit, as it is reached now.
 * Only `init --allow-unreachable` and an accepted change in `review` write these; a plain `init`
 * that could not reach a server fails and says so rather than agreeing to it.
 */
export function unauditedToRecord(result: CaptureResult, keep: (name: string) => boolean = () => true): Record<string, LockedUnaudited> | undefined {
  const entries = Object.entries(result.unaudited).filter(([name]) => keep(name));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * A failure reason with the values this run was given to reach the server taken out of it.
 *
 * Reasons quote the server and the libraries talking to it -- an error message, the last lines of
 * stderr -- and they are printed, posted on the pull request and sent in the reading. A server that
 * logs "invalid key sk-live-..." on the way out put the project's key into all three.
 */
export function withoutSecrets(reason: string, server: ConfiguredServer): string {
  const { transport } = server;
  const secrets: string[] = [];
  if (transport.type === "stdio") {
    for (const [name, value] of Object.entries(transport.env)) {
      if (isCredentialName(name) || (value.length >= 16 && !/[\s/\\]/.test(value))) secrets.push(value);
    }
  } else {
    for (const value of Object.values(transport.headers)) secrets.push(value, ...value.split(/\s+/));
    if (transport.oauth?.clientSecret) secrets.push(transport.oauth.clientSecret);
  }
  let out = reason;
  // Longest first, so a whole header value goes before the token inside it.
  for (const secret of [...new Set(secrets)].filter((value) => value.length >= 8).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
