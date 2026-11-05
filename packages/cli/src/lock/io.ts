/**
 * Reading and writing `mcp.lock`.
 *
 * The on-disk layout is chosen for the reviewer, not the parser. Structural keys come out in a
 * declared order that reads top-down -- what the server is, then what it can do -- while
 * free-form subtrees (JSON Schemas, capabilities, `_meta`) are sorted, because they have no
 * meaningful order and sorting is what keeps a server's reserialization from showing up as a
 * diff. Hashing is unaffected: digests are computed over RFC 8785 canonical form, which sorts
 * everything. See docs/lockfile.md §2.
 */
import { reseal } from "@nulladrift/core";
import { readFile, writeFile } from "node:fs/promises";
import { lockfileSchema } from "./schema";
import type { Lockfile } from "./types";
import { LOCKFILE_VERSION } from "./types";

export const DEFAULT_LOCK_FILENAME = "mcp.lock";

/** Declared key order per structural node. Anything not listed here is sorted. */
const KEY_ORDER = {
  root: ["lockfileVersion", "generatedBy", "policy", "subjects"],
  policy: ["ignoreMetaPrefixes", "allowUnreachable"],
  server: ["kind", "source", "transport", "protocol", "serverInfo", "capabilities", "instructions", "tools", "resources", "resourceTemplates", "prompts", "digest"],
  source: ["client", "file", "scope"],
  transport: ["type", "command", "args", "envKeys", "cwd", "url", "headerKeys"],
  protocol: ["era", "version", "supportedVersions"],
  serverInfo: ["name", "title", "version", "description", "websiteUrl"],
  tool: ["name", "title", "description", "inputSchema", "outputSchema", "annotations", "behavior", "headerParams", "icons", "meta", "digest"],
  resource: ["uri", "name", "title", "description", "mimeType", "annotations", "icons", "meta", "digest"],
  resourceTemplate: ["uriTemplate", "name", "title", "description", "mimeType", "annotations", "icons", "meta", "digest"],
  prompt: ["name", "title", "description", "arguments", "icons", "meta", "digest"],
  promptArgument: ["name", "title", "description", "required"],
  icon: ["src", "mimeType", "sizes", "theme"],
} as const satisfies Record<string, readonly string[]>;

type NodeKind = keyof typeof KEY_ORDER;

/** Per-key recursion: which declared order (if any) a child node should be printed with. */
const CHILD_KIND: Partial<Record<string, NodeKind>> = {
  policy: "policy",
  source: "source",
  transport: "transport",
  protocol: "protocol",
  serverInfo: "serverInfo",
  tools: "tool",
  resources: "resource",
  resourceTemplates: "resourceTemplate",
  prompts: "prompt",
  arguments: "promptArgument",
  icons: "icon",
};

const INDENT = "  ";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printScalar(value: unknown): string {
  return JSON.stringify(value);
}

function printObject(value: Record<string, unknown>, kind: NodeKind | undefined, depth: number): string {
  const declared: readonly string[] = kind ? KEY_ORDER[kind] : [];
  const present = Object.keys(value).filter((key) => value[key] !== undefined);
  const ordered = kind
    ? [...declared.filter((key) => present.includes(key)), ...present.filter((key) => !declared.includes(key)).sort()]
    : present.sort();

  if (ordered.length === 0) return "{}";

  const pad = INDENT.repeat(depth + 1);
  const body = ordered
    .map((key) => `${pad}${JSON.stringify(key)}: ${printNode(value[key], CHILD_KIND[key], depth + 1)}`)
    .join(",\n");
  return `{\n${body}\n${INDENT.repeat(depth)}}`;
}

function printArray(value: unknown[], kind: NodeKind | undefined, depth: number): string {
  if (value.length === 0) return "[]";
  // Arrays of scalars stay on one line; they are short and a column of strings reads worse.
  if (value.every((entry) => !isPlainObject(entry) && !Array.isArray(entry))) {
    return `[${value.map(printScalar).join(", ")}]`;
  }
  const pad = INDENT.repeat(depth + 1);
  const body = value.map((entry) => `${pad}${printNode(entry, kind, depth + 1)}`).join(",\n");
  return `[\n${body}\n${INDENT.repeat(depth)}]`;
}

function printNode(value: unknown, kind: NodeKind | undefined, depth: number): string {
  if (Array.isArray(value)) return printArray(value, kind, depth);
  if (isPlainObject(value)) return printObject(value, kind, depth);
  return printScalar(value);
}

export function serializeLockfile(lock: Lockfile): string {
  const root: Record<string, unknown> = {
    lockfileVersion: lock.lockfileVersion,
    generatedBy: lock.generatedBy,
    policy: lock.policy,
    // Names sorted so that adding one produces a localized diff.
    subjects: Object.fromEntries(
      Object.keys(lock.subjects)
        .sort()
        .map((name) => [name, lock.subjects[name]]),
    ),
  };

  // `subjects` is a map of arbitrary names, so its children are printed as nodes by hand.
  const pad = INDENT;
  const parts: string[] = [];
  for (const key of KEY_ORDER.root) {
    const value = root[key];
    if (value === undefined) continue;
    if (key === "subjects") {
      const names = Object.keys(value as Record<string, unknown>);
      const body =
        names.length === 0
          ? "{}"
          : `{\n${names
              .map((name) => `${INDENT.repeat(2)}${JSON.stringify(name)}: ${printNode((value as Record<string, unknown>)[name], "server", 2)}`)
              .join(",\n")}\n${pad}}`;
      parts.push(`${pad}${JSON.stringify(key)}: ${body}`);
      continue;
    }
    parts.push(`${pad}${JSON.stringify(key)}: ${printNode(value, CHILD_KIND[key], 1)}`);
  }
  return `{\n${parts.join(",\n")}\n}\n`;
}

/**
 * Version 1 to version 2: `servers` became `subjects`, and each entry says what it is.
 *
 * Upgraded rather than refused, because the change is to the shape of the file and not to
 * anything it asserts. `kind` is outside every digest (`reseal.ts` covers an explicit field
 * list), so an upgraded lock reseals to exactly the digests it already carried. Nobody sees
 * drift that is really a rename, which is the whole reason this is safe to do silently.
 *
 * A caller that writes the lock back gets version 2 on disk. One that only reads it leaves the
 * file alone, so upgrading is not something a `check` run does behind anybody's back.
 */
function upgradeFromV1(raw: Record<string, unknown>): Record<string, unknown> {
  const servers = isPlainObject(raw["servers"]) ? (raw["servers"] as Record<string, unknown>) : {};
  const subjects = Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => [name, isPlainObject(entry) ? { kind: "mcp-server", ...entry } : entry]),
  );
  const { servers: _dropped, ...rest } = raw;
  return { ...rest, lockfileVersion: LOCKFILE_VERSION, subjects };
}

export class LockfileError extends Error {}

export function parseLockfile(text: string, path: string): Lockfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new LockfileError(`${path} is not valid JSON: ${(error as Error).message}`);
  }

  const version = isPlainObject(raw) ? raw["lockfileVersion"] : undefined;
  if (version === 1) raw = upgradeFromV1(raw as Record<string, unknown>);
  else if (typeof version === "number" && version !== LOCKFILE_VERSION) {
    throw new LockfileError(
      `${path} is lockfileVersion ${version}; this build understands ${LOCKFILE_VERSION}. Upgrade nulladrift rather than letting it guess.`,
    );
  }

  const parsed = lockfileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
    throw new LockfileError(`${path} is not a valid lockfile${where}: ${first?.message ?? "unknown error"}`);
  }
  return parsed.data as Lockfile;
}

/**
 * Every digest in a lockfile read from disk is recomputed from the content beside it.
 *
 * The diff engine short-circuits on the subject digest, which is right only when the lockfile and
 * the reading came from the same process. A lockfile has not: it is read from a repository, after
 * git, merges and hands. Taking its digest at face value meant any edit to a locked surface that
 * left the digest alone compared as clean, forever -- `check` reported "1 server(s) match" for a
 * lock whose `browser_navigate` description had been rewritten to read ~/.aws/credentials, and
 * went on reporting it with the digest zeroed out, because the digest it trusted was the one in
 * the file.
 *
 * The control plane already reseals on ingest for exactly this reason and says so in `reseal.ts`.
 * The collector is in the same position with respect to its own lockfile, so it does the same.
 * An honest lock reseals to precisely the digests it arrived with; a tampered or badly merged one
 * reseals to different ones and shows up as the drift it is.
 */
export async function readLockfile(path: string): Promise<Lockfile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new LockfileError(`no lockfile at ${path}. Run \`nulladrift init\` first.`);
    throw new LockfileError(`could not read ${path}: ${(error as Error).message}`);
  }
  const lock = parseLockfile(text, path);
  return {
    ...lock,
    subjects: Object.fromEntries(Object.entries(lock.subjects).map(([name, subject]) => [name, reseal(subject)])),
  };
}

export async function writeLockfile(path: string, lock: Lockfile): Promise<void> {
  try {
    await writeFile(path, serializeLockfile(lock), "utf8");
  } catch (error) {
    /*
     * A raw ENOENT and a stack trace is not an answer. `--lock` is resolved against `--cwd`, so
     * a path that looks right from the shell can land in a directory that does not exist, and the
     * tool used to print Node's error verbatim with four frames of its own internals under it.
     */
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new LockfileError(`cannot write ${path}: the directory does not exist. Note that --lock is resolved against --cwd.`);
    if (code === "EACCES" || code === "EPERM") throw new LockfileError(`cannot write ${path}: permission denied.`);
    throw new LockfileError(`cannot write ${path}: ${(error as Error).message}`);
  }
}
