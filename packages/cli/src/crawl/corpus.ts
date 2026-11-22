/**
 * The crawl's pinned corpus, one lockfile per server.
 *
 * It was one `corpus.lock` holding every server, and at 6,215 servers that file was 305 MB. GitHub
 * refuses any file over 100 MB, so the commit that saves the crawl's state failed every day: the
 * crawl ran, measured, and threw the measurement away, and the next run started from nothing and
 * reported "not enough history yet" again. The rate the project exists to measure never began to
 * accumulate.
 *
 * One file per server fixes that and is better in its own right. No file is anywhere near the
 * limit (the largest server is a few megabytes); a day's commit changes only the servers that
 * moved, so git stores the difference rather than another copy of everything; and a server's
 * history is `git log` on one file.
 *
 * Each file is an ordinary `mcp.lock` of one server, written and read by the same code the product
 * ships, so the crawl remains the largest thing that exercises the format.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { LOCKFILE_VERSION } from "../lock/types";
import type { LockedSubject } from "../lock/types";
import { readLockfile, writeLockfile } from "../lock/io";

/** Where the per-server lockfiles live, under the state directory. */
export const CORPUS_DIR = "corpus";
/** The single file the corpus used to be. Read once, so existing state carries over, then removed. */
export const LEGACY_CORPUS_LOCK = "corpus.lock";

const SUFFIX = ".lock";

/**
 * Where one server's lockfile goes, relative to the state directory.
 *
 * Registry names hold `/` and could differ only in case, which two filesystems in common use
 * would merge, so the name is not the path. A hash is: its first two characters pick one of 256
 * directories, which keeps every directory small enough to list, and the rest keeps the file
 * unique. The readable part is only for whoever browses the branch.
 */
export function corpusFile(name: string): string {
  const hash = createHash("sha256").update(name).digest("hex");
  const readable = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "server";
  return join(CORPUS_DIR, hash.slice(0, 2), `${readable}-${hash.slice(2, 14)}${SUFFIX}`);
}

async function lockfilesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const shard of await readdir(dir).catch(() => [] as string[])) {
    const shardPath = join(dir, shard);
    if (!(await lstat(shardPath)).isDirectory()) continue;
    for (const file of await readdir(shardPath)) if (file.endsWith(SUFFIX)) found.push(join(shardPath, file));
  }
  return found.sort();
}

export interface CorpusRead {
  subjects: Record<string, LockedSubject>;
  /**
   * Files that could not be read, relative to the state directory. Each costs one server its
   * baseline and nothing more: one bad file must not make the whole corpus look empty, which is
   * how a broken state used to pass for a first run.
   */
  unreadable: string[];
  /** Whether the old single-file corpus was there, and so read. */
  legacy: boolean;
}

/** Every pinned server, from the per-server files and, if it is still there, the old single file. */
export async function readCorpus(stateDir: string): Promise<CorpusRead> {
  const subjects: Record<string, LockedSubject> = {};
  const unreadable: string[] = [];

  let legacy = false;
  const legacyPath = join(stateDir, LEGACY_CORPUS_LOCK);
  if (await lstat(legacyPath).then((stat) => stat.isFile(), () => false)) {
    legacy = true;
    try {
      Object.assign(subjects, (await readLockfile(legacyPath)).subjects);
    } catch {
      unreadable.push(LEGACY_CORPUS_LOCK);
    }
  }

  // After the legacy file, so a per-server file -- the newer record -- wins where both exist.
  for (const path of await lockfilesUnder(join(stateDir, CORPUS_DIR))) {
    try {
      const lock = await readLockfile(path);
      const entries = Object.entries(lock.subjects);
      if (entries.length !== 1) throw new Error("not a lockfile of one server");
      const [name, subject] = entries[0]!;
      // A file whose name does not match where it lives was put there by something else.
      if (corpusFile(name) !== relative(stateDir, path)) throw new Error("in the wrong place for the server it names");
      subjects[name] = subject;
    } catch {
      unreadable.push(relative(stateDir, path));
    }
  }
  return { subjects, unreadable, legacy };
}

/**
 * The corpus as `subjects`, one file per server: every one written, every file for a server no
 * longer in it removed, and the old single file removed once its contents are in the new form.
 */
export async function writeCorpus(stateDir: string, subjects: Record<string, LockedSubject>): Promise<{ written: number; removed: number }> {
  const wanted = new Set<string>();
  for (const [name, subject] of Object.entries(subjects).sort(([a], [b]) => a.localeCompare(b))) {
    const file = corpusFile(name);
    wanted.add(file);
    await mkdir(join(stateDir, file, ".."), { recursive: true });
    // No `generatedBy`: it would change every file on every release, and say nothing a run's own
    // record in history.json does not.
    await writeLockfile(join(stateDir, file), { lockfileVersion: LOCKFILE_VERSION, subjects: { [name]: subject } });
  }

  let removed = 0;
  for (const path of await lockfilesUnder(join(stateDir, CORPUS_DIR))) {
    if (wanted.has(relative(stateDir, path))) continue;
    await rm(path);
    removed += 1;
  }
  await rm(join(stateDir, LEGACY_CORPUS_LOCK), { force: true });
  return { written: wanted.size, removed };
}
