/**
 * The crawl's corpus on disk, one lockfile per server.
 *
 * It was one `corpus.lock` of every server, 305 MB at 6,215 servers, and GitHub refuses a file
 * over 100 MB: the commit that saves the crawl's state failed every day, so each run started from
 * nothing and the drift rate never began to accumulate.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORPUS_DIR, corpusFile, LEGACY_CORPUS_LOCK, readCorpus, writeCorpus } from "../src/crawl/corpus";
import { buildLockedServer } from "../src/lock/build";
import { writeLockfile } from "../src/lock/io";
import { LOCKFILE_VERSION, type LockedSubject } from "../src/lock/types";
import { configured, makeTool } from "./helpers";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nulladrift-corpus-"));
  dirs.push(dir);
  return dir;
}

/** A pinned server with one tool, as the crawl would hold it. */
function server(name: string, description = "Reads a file."): LockedSubject {
  return buildLockedServer(configured(name), {
    protocol: { era: "modern", version: "2026-07-28" },
    serverInfo: { name, version: "1.0.0" },
    tools: [makeTool({ name: "read_file", description })],
    resources: [],
    resourceTemplates: [],
    prompts: [],
  });
}

describe("where a server's lockfile goes", () => {
  it("puts registry names with slashes in a file, under one of 256 directories", () => {
    const path = corpusFile("com.replynodes/mcp");
    expect(path).toMatch(new RegExp(`^${CORPUS_DIR}/[0-9a-f]{2}/com.replynodes_mcp-[0-9a-f]{12}\\.lock$`));
  });

  it("keeps names apart that differ only in case, which some filesystems would merge", () => {
    expect(corpusFile("io.example/Server").toLowerCase()).not.toBe(corpusFile("io.example/server").toLowerCase());
  });

  it("never lets a name climb out of the corpus", () => {
    expect(corpusFile("../../etc/passwd")).toMatch(new RegExp(`^${CORPUS_DIR}/[0-9a-f]{2}/[^/]+\\.lock$`));
  });
});

describe("reading and writing the corpus", () => {
  it("writes each server as an mcp.lock of one, and reads the same servers back", async () => {
    const state = await stateDir();
    await writeCorpus(state, { "io.example/alpha": server("io.example/alpha"), "io.example/beta": server("io.example/beta") });

    const read = await readCorpus(state);
    expect(Object.keys(read.subjects).sort()).toEqual(["io.example/alpha", "io.example/beta"]);
    expect(read.unreadable).toEqual([]);
    const text = await readFile(join(state, corpusFile("io.example/alpha")), "utf8");
    expect(JSON.parse(text)).toMatchObject({ lockfileVersion: LOCKFILE_VERSION, subjects: { "io.example/alpha": {} } });
    // Nothing that changes from run to run without the server changing.
    expect(JSON.parse(text).generatedBy).toBeUndefined();
  });

  it("leaves an unchanged server's file byte-for-byte alone", async () => {
    const state = await stateDir();
    const servers = { "io.example/alpha": server("io.example/alpha") };
    await writeCorpus(state, servers);
    const before = await readFile(join(state, corpusFile("io.example/alpha")), "utf8");
    await writeCorpus(state, (await readCorpus(state)).subjects);
    expect(await readFile(join(state, corpusFile("io.example/alpha")), "utf8")).toBe(before);
  });

  it("removes the file of a server no longer in the corpus", async () => {
    const state = await stateDir();
    await writeCorpus(state, { "io.example/alpha": server("io.example/alpha"), "io.example/beta": server("io.example/beta") });
    const { removed } = await writeCorpus(state, { "io.example/alpha": server("io.example/alpha") });
    expect(removed).toBe(1);
    await expect(stat(join(state, corpusFile("io.example/beta")))).rejects.toThrow();
  });

  it("reads the old single corpus.lock once, then replaces it", async () => {
    const state = await stateDir();
    await writeLockfile(join(state, LEGACY_CORPUS_LOCK), { lockfileVersion: LOCKFILE_VERSION, subjects: { "io.example/alpha": server("io.example/alpha") } });

    const read = await readCorpus(state);
    expect(read.legacy).toBe(true);
    expect(Object.keys(read.subjects)).toEqual(["io.example/alpha"]);

    await writeCorpus(state, read.subjects);
    expect(await readdir(state)).not.toContain(LEGACY_CORPUS_LOCK);
    expect(Object.keys((await readCorpus(state)).subjects)).toEqual(["io.example/alpha"]);
  });

  it("prefers a server's own file to the old single file, which is older", async () => {
    const state = await stateDir();
    await writeLockfile(join(state, LEGACY_CORPUS_LOCK), { lockfileVersion: LOCKFILE_VERSION, subjects: { "io.example/alpha": server("io.example/alpha", "old") } });
    await writeCorpus(state, { "io.example/alpha": server("io.example/alpha", "new") });
    await writeLockfile(join(state, LEGACY_CORPUS_LOCK), { lockfileVersion: LOCKFILE_VERSION, subjects: { "io.example/alpha": server("io.example/alpha", "old") } });

    const tool = (await readCorpus(state)).subjects["io.example/alpha"];
    expect(tool && "tools" in tool ? tool.tools?.[0]?.description : undefined).toBe("new");
  });

  /*
   * One unreadable file used to be the whole corpus: the single lock was read with a catch that
   * returned an empty corpus, so a damaged state looked exactly like a first run.
   */
  it("loses only the server whose file cannot be read, and says which", async () => {
    const state = await stateDir();
    await writeCorpus(state, { "io.example/alpha": server("io.example/alpha"), "io.example/beta": server("io.example/beta") });
    await writeFile(join(state, corpusFile("io.example/beta")), "{ not json", "utf8");

    const read = await readCorpus(state);
    expect(Object.keys(read.subjects)).toEqual(["io.example/alpha"]);
    expect(read.unreadable).toEqual([corpusFile("io.example/beta")]);
  });

  it("does not believe a file that names a server other than the one its path is for", async () => {
    const state = await stateDir();
    await writeCorpus(state, { "io.example/alpha": server("io.example/alpha") });
    const misplaced = join(state, CORPUS_DIR, "00", `elsewhere-000000000000.lock`);
    await mkdir(join(state, CORPUS_DIR, "00"), { recursive: true });
    await writeLockfile(misplaced, { lockfileVersion: LOCKFILE_VERSION, subjects: { "io.example/mallory": server("io.example/mallory") } });

    const read = await readCorpus(state);
    expect(read.subjects["io.example/mallory"]).toBeUndefined();
    expect(read.unreadable).toEqual([join(CORPUS_DIR, "00", "elsewhere-000000000000.lock")]);
  });

  it("is empty, not an error, on a first run", async () => {
    const read = await readCorpus(await stateDir());
    expect(read).toEqual({ subjects: {}, unreadable: [], legacy: false });
  });
});
