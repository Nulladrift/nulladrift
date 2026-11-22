/**
 * Server names that Object.prototype already has, through init, check, review and the crawl.
 *
 * `committed.subjects["constructor"]` is the Object constructor on any parsed lock, so a pull
 * request adding a server called `constructor` that exits before it can be audited -- `bash -c
 * "curl ... | sh; exit 1"` -- was taken for a pinned server and `check --allow-unreachable` exited
 * 0. A skipped server called `__proto__` was assigned through the prototype setter and vanished
 * from the list of servers that could not be audited, with the same result. Found in an audit.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredServer } from "../src/config/types";
import { runCheck } from "../src/commands/check";
import { runInit } from "../src/commands/init";
import { runReview } from "../src/commands/review";
import type { CommonOptions } from "../src/commands/options";
import { crawl } from "../src/crawl/run";
import { EXIT_CLEAN, EXIT_DRIFT } from "../src/lib/exit";
import { readLockfile } from "../src/lock/io";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const TIMEOUT_MS = 20_000;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Written as text: `__proto__` in an object literal sets the prototype instead of adding a key. */
async function workspace(servers: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-names-"));
  dirs.push(root);
  await configure(root, servers);
  return root;
}

async function configure(root: string, servers: string): Promise<void> {
  await writeFile(join(root, ".mcp.json"), `{ "mcpServers": { ${servers} } }`, "utf8");
}

const fixture = `"fixture": ${JSON.stringify({ command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: "base" } })}`;
/** A server that exits before it can be audited, which is all the attack needs. */
const exitsAt = (name: string) => `${JSON.stringify(name)}: ${JSON.stringify({ command: process.execPath, args: ["-e", "process.exit(1)"] })}`;

function options(root: string, overrides: Partial<CommonOptions> = {}): CommonOptions {
  return { projectRoot: root, lockPath: join(root, "mcp.lock"), configFiles: [], timeoutMs: TIMEOUT_MS, allowUnreachable: false, format: "human", ...overrides };
}

async function run<T>(root: string, body: () => Promise<T>): Promise<{ result: T; output: string }> {
  const previousHome = process.env["HOME"];
  process.env["HOME"] = join(root, "no-home");
  const writes = [process.stdout, process.stderr].map((stream) => stream.write.bind(stream));
  let output = "";
  const capture = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    return { result: await body(), output };
  } finally {
    process.stdout.write = writes[0]!;
    process.stderr.write = writes[1]!;
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
  }
}

describe("a server named after a member of Object.prototype", () => {
  it.each(["constructor", "toString", "hasOwnProperty"])(
    "is new, and could not be audited, when a pull request adds one called %s",
    async (name) => {
      const root = await workspace(fixture);
      expect((await run(root, () => runInit(options(root)))).result).toBe(EXIT_CLEAN);

      await configure(root, `${fixture}, ${exitsAt(name)}`);
      const check = await run(root, () => runCheck(options(root, { allowUnreachable: true, timeoutMs: 5_000 })));
      expect(check.result).toBe(EXIT_DRIFT);
      expect(check.output).toContain("server.added");
      expect(check.output).toContain("new server, which could not be audited");
    },
    TIMEOUT_MS * 2,
  );

  it(
    "is agreed to in review as itself, and the lock it writes reads back",
    async () => {
      const root = await workspace(fixture);
      await run(root, () => runInit(options(root)));
      await configure(root, `${fixture}, ${exitsAt("constructor")}`);

      const review = await run(root, () => runReview({ ...options(root, { allowUnreachable: true, timeoutMs: 5_000 }), acceptAll: true }));
      expect(review.result).toBe(EXIT_CLEAN);
      const lock = await readLockfile(join(root, "mcp.lock"));
      expect(Object.keys(lock.subjects)).toEqual(["fixture"]);
      expect(Object.hasOwn(lock.unaudited ?? {}, "constructor")).toBe(true);
      expect(lock.unaudited?.["constructor"]?.transport).toMatchObject({ type: "stdio", command: process.execPath });

      expect((await run(root, () => runCheck(options(root, { allowUnreachable: true, timeoutMs: 5_000 })))).result).toBe(EXIT_CLEAN);
    },
    TIMEOUT_MS * 3,
  );
});

describe("a server named __proto__", () => {
  it(
    "is reported as new and unaudited, not lost through the prototype setter",
    async () => {
      const root = await workspace(fixture);
      await run(root, () => runInit(options(root)));

      await configure(root, `${fixture}, ${exitsAt("__proto__")}`);
      const check = await run(root, () => runCheck(options(root, { allowUnreachable: true, timeoutMs: 5_000 })));
      expect(check.result).toBe(EXIT_DRIFT);
      expect(check.output).toContain("__proto__");
      expect(check.output).toContain("server.added");
    },
    TIMEOUT_MS * 2,
  );

  it(
    "is never written into the lock as agreed to, because it cannot be read back from one",
    async () => {
      const root = await workspace(`${fixture}, ${exitsAt("__proto__")}`);
      await run(root, () => runInit(options(root, { allowUnreachable: true, timeoutMs: 5_000 })));
      expect(await readFile(join(root, "mcp.lock"), "utf8")).not.toContain("__proto__");
      expect((await run(root, () => runCheck(options(root, { allowUnreachable: true, timeoutMs: 5_000 })))).result).toBe(EXIT_DRIFT);
    },
    TIMEOUT_MS * 2,
  );
});

describe("the crawl", () => {
  it(
    "baselines a server called constructor rather than calling it stable",
    async () => {
      const state = await mkdtemp(join(tmpdir(), "nulladrift-names-crawl-"));
      dirs.push(state);
      const target: ConfiguredServer = {
        name: "constructor",
        source: { client: "manual", file: "test" },
        transport: { type: "stdio", command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: "base" } },
      };
      const first = await crawl({
        stateDir: state,
        corpus: { targets: [target], stats: { latest: 1, remote: 0, stdioOnly: 1, stdioSandboxed: 0, stdioUnsupported: 0, truncated: false } },
        now: new Date("2026-01-01T00:00:00.000Z"),
        timeoutMs: TIMEOUT_MS,
      });
      expect(first.run.outcomes).toMatchObject({ baseline: 1, stable: 0 });
      expect(first.history.servers["constructor"]).toMatchObject({ comparisons: 0, driftEvents: 0 });
    },
    TIMEOUT_MS,
  );
});
