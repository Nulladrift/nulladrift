/**
 * The interactive path. `--accept-all` and the non-TTY refusal were covered; the prompt itself
 * -- the thing a human actually uses -- was not, and it is the one place a wrong answer writes
 * the lockfile.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: string[] = [];
const asked: string[] = [];

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (prompt: string) => {
      asked.push(prompt);
      return answers.shift() ?? "n";
    },
    close: () => {},
  }),
}));

const { runInit } = await import("../src/commands/init");
const { runReview } = await import("../src/commands/review");
const { runCheck } = await import("../src/commands/check");
const { EXIT_CLEAN, EXIT_DRIFT } = await import("../src/lib/exit");
const { readLockfile } = await import("../src/lock/io");
type CommonOptions = import("../src/commands/options").CommonOptions;

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const TIMEOUT = 25_000;

let root: string;
let previousHome: string | undefined;
let ttyIn: unknown;
let ttyOut: unknown;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-review-"));
  previousHome = process.env["HOME"];
  process.env["HOME"] = join(root, "no-home");
  ttyIn = process.stdin.isTTY;
  ttyOut = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  answers.length = 0;
  asked.length = 0;
});

afterEach(async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: ttyIn, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: ttyOut, configurable: true });
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  await rm(root, { recursive: true, force: true });
});

function options(): CommonOptions {
  return { projectRoot: root, lockPath: join(root, "mcp.lock"), configFiles: [], timeoutMs: TIMEOUT, allowUnreachable: false, format: "human" };
}

async function configure(variant: string): Promise<void> {
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: variant } } } }),
    "utf8",
  );
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = original;
  }
}

describe("review at a prompt", () => {
  it(
    "writes the new surface into the lock when the answer is yes",
    async () => {
      await configure("base");
      await quietly(() => runInit(options()));
      await configure("drifted");

      answers.push("y");
      expect(await quietly(() => runReview({ ...options(), acceptAll: false }))).toBe(EXIT_CLEAN);
      expect(asked[0]).toContain("Accept these");

      expect((await readLockfile(join(root, "mcp.lock"))).subjects["fixture"]?.serverInfo?.version).toBe("2.0.0");
      expect(await quietly(() => runCheck(options()))).toBe(EXIT_CLEAN);
    },
    TIMEOUT * 3,
  );

  it(
    "leaves the lock alone on anything that is not yes, and check still fails",
    async () => {
      await configure("base");
      await quietly(() => runInit(options()));
      await configure("drifted");

      // Enter, a typo, anything -- the default is to keep the reviewed surface.
      answers.push("");
      expect(await quietly(() => runReview({ ...options(), acceptAll: false }))).toBe(EXIT_DRIFT);
      expect((await readLockfile(join(root, "mcp.lock"))).subjects["fixture"]?.serverInfo?.version).toBe("1.0.0");
      expect(await quietly(() => runCheck(options()))).toBe(EXIT_DRIFT);
    },
    TIMEOUT * 3,
  );

  it(
    "asks once per server, not once per change",
    async () => {
      await configure("base");
      await quietly(() => runInit(options()));
      await configure("drifted");

      answers.push("yes");
      await quietly(() => runReview({ ...options(), acceptAll: false }));
      // The drifted fixture produces several findings on one server; a per-change prompt would
      // let someone accept half a surface no server ever served.
      expect(asked).toHaveLength(1);
    },
    TIMEOUT * 3,
  );
});
