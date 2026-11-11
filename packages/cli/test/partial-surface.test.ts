/**
 * A surface that could not be read in full.
 *
 * Decided 6 November 2026 (roadmap.md, "Progressive tool discovery"): a reading carries whether
 * its surface was fully enumerated, and one that was not is neither drift nor clean. It is an
 * unfinished audit, exit 2, unless `--allow-partial` or `policy.allowPartial` says that is
 * acceptable -- the choice `--allow-unreachable` already makes about a server that could not be
 * read at all.
 *
 * Only facts the protocol states make a reading partial, never a guess from a tool's name: a
 * listing that does not end, or one the server says changed while it was being read, on every
 * pass. A server that says so once, at start-up, is read again and is complete.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/commands/check";
import { runInit } from "../src/commands/init";
import type { CommonOptions } from "../src/commands/options";
import { EXIT_CLEAN, EXIT_INCOMPLETE } from "../src/lib/exit";
import { readLockfile, writeLockfile } from "../src/lock/io";
import { captureSurface } from "../src/mcp/capture";
import { configured } from "./helpers";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const fixture = (variant: string) => ({ type: "stdio" as const, command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: variant } });

describe("reading a listing", () => {
  it("pins the pages of a listing that never ends, and says it is partial", async () => {
    const surface = await captureSurface(configured("s", fixture("endless")), 30_000);
    expect(surface.tools).toHaveLength(64);
    expect(surface.coverage?.reasons.join(" ")).toMatch(/did not end within 64 pages/);
  }, 60_000);

  it("stops at a repeated cursor and says the listing never ends", async () => {
    const surface = await captureSurface(configured("s", fixture("loop")), 15_000);
    expect(surface.tools.map((tool) => tool.name)).toEqual(["t0", "t1", "t2"]);
    expect(surface.coverage?.reasons.join(" ")).toMatch(/repeated a page cursor/);
  });

  it("calls a surface that changed while being read, on every pass, partial", async () => {
    const surface = await captureSurface(configured("s", fixture("restless")), 15_000);
    expect(surface.coverage?.reasons.join(" ")).toMatch(/said its tools changed while being read/);
  });

  it("reads again after one change notice, and is then complete", async () => {
    const surface = await captureSurface(configured("s", fixture("settles")), 15_000);
    expect(surface.coverage).toBeUndefined();
    expect(surface.tools.length).toBeGreaterThan(0);
  });

  it("is complete for an ordinary server", async () => {
    expect((await captureSurface(configured("s", fixture("base")), 15_000)).coverage).toBeUndefined();
  });
});

describe("what the commands make of it", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function project(variant: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "nulladrift-partial-"));
    roots.push(root);
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { s: fixture(variant) } }), "utf8");
    return root;
  }
  const options = (root: string, overrides: Partial<CommonOptions> = {}): CommonOptions => ({
    projectRoot: root,
    lockPath: join(root, "mcp.lock"),
    configFiles: [],
    timeoutMs: 15_000,
    allowUnreachable: false,
    format: "json",
    provenance: false,
    ...overrides,
  });
  async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; out: string }> {
    const write = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    let out = "";
    process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      return { result: await run(), out };
    } finally {
      process.stdout.write = write;
      process.stderr.write = errWrite;
    }
  }

  it("init pins what it read, records that it is partial, and does not call it finished", async () => {
    const root = await project("restless");
    const { result } = await quietly(() => runInit({ ...options(root), format: "human" }));
    expect(result).toBe(EXIT_INCOMPLETE);
    const lock = await readLockfile(join(root, "mcp.lock"));
    expect(lock.subjects["s"]?.coverage?.complete).toBe(false);
  });

  it("check fails a partial reading with exit 2, and says why in the report", async () => {
    const root = await project("restless");
    await quietly(() => runInit({ ...options(root), format: "human", allowPartial: true }));

    const { result, out } = await quietly(() => runCheck(options(root)));
    expect(result).toBe(EXIT_INCOMPLETE);
    const report = JSON.parse(out) as { summary: { partial: number }; partial: Array<{ server: string }> };
    expect(report.summary.partial).toBe(1);
    expect(report.partial[0]?.server).toBe("s");
  });

  it("check passes it with --allow-partial, or with policy.allowPartial in the lock", async () => {
    const root = await project("restless");
    await quietly(() => runInit({ ...options(root), format: "human", allowPartial: true }));

    expect((await quietly(() => runCheck(options(root, { allowPartial: true })))).result).toBe(EXIT_CLEAN);

    const lock = await readLockfile(join(root, "mcp.lock"));
    await writeLockfile(join(root, "mcp.lock"), { ...lock, policy: { ...lock.policy, allowPartial: true } });
    expect((await quietly(() => runCheck(options(root)))).result).toBe(EXIT_CLEAN);
    expect(await readFile(join(root, "mcp.lock"), "utf8")).toContain('"allowPartial": true');
  });

  it("never prints a clean tick over a partial reading", async () => {
    const root = await project("restless");
    await quietly(() => runInit({ ...options(root), format: "human", allowPartial: true }));
    const { out } = await quietly(() => runCheck(options(root, { format: "human", allowPartial: true })));
    expect(out).toContain("Could not read 1 server(s) in full");
    expect(out).not.toMatch(/✓ \d+ server\(s\) match/);
  });
});
