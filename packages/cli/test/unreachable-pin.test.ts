/**
 * A pinned server that is still configured and could not be read this time.
 *
 * It was reported as `server.removed`, "no longer configured", so `--allow-unreachable` exited 1
 * though the flag says an unreachable server warns; `review --accept-all` then deleted its pin, and
 * when the server answered again it came back as a new server rather than as the changes it had
 * made. Found in an audit.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/commands/check";
import { runInit } from "../src/commands/init";
import { runReview } from "../src/commands/review";
import type { CommonOptions } from "../src/commands/options";
import { EXIT_CLEAN, EXIT_DRIFT, EXIT_INCOMPLETE } from "../src/lib/exit";
import { readLockfile } from "../src/lock/io";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const TIMEOUT_MS = 20_000;
/** Long enough for the fixture to answer, short enough that the silent one is given up on quickly. */
const BUDGET_MS = 3_000;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fixture = (variant: string) => ({ command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: variant } });

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-unread-pin-"));
  dirs.push(root);
  return root;
}

async function configure(root: string, servers: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
}

function options(root: string, overrides: Partial<CommonOptions> = {}): CommonOptions {
  return { projectRoot: root, lockPath: join(root, "mcp.lock"), configFiles: [], timeoutMs: BUDGET_MS, allowUnreachable: true, format: "human", provenance: false, ...overrides };
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

describe("a pinned server that does not answer this time", () => {
  it(
    "warns under --allow-unreachable, keeps its pin through review, and is compared field by field when it is back",
    async () => {
      const root = await workspace();
      await configure(root, { fixture: fixture("base") });
      expect((await run(root, () => runInit(options(root, { allowUnreachable: false })))).result).toBe(EXIT_CLEAN);

      // The same definition; the server just does not answer. Its environment is not its transport.
      await configure(root, { fixture: fixture("silent") });
      const lenient = await run(root, () => runCheck(options(root)));
      expect(lenient.output).not.toContain("server.removed");
      expect(lenient.output).not.toContain("no longer configured");
      expect(lenient.result).toBe(EXIT_CLEAN);
      expect((await run(root, () => runCheck(options(root, { allowUnreachable: false })))).result).toBe(EXIT_INCOMPLETE);

      const review = await run(root, () => runReview({ ...options(root), acceptAll: true }));
      expect(review.result).toBe(EXIT_CLEAN);
      expect((await readLockfile(join(root, "mcp.lock"))).subjects["fixture"]?.serverInfo?.version).toBe("1.0.0");

      // Back, and changed: the changes it made, not a server nobody has seen.
      await configure(root, { fixture: fixture("drifted") });
      const back = await run(root, () => runCheck(options(root, { format: "json" })));
      expect(back.result).toBe(EXIT_DRIFT);
      const kinds = (JSON.parse(back.output.slice(back.output.indexOf("{"))) as { changes: Array<{ kind: string }> }).changes.map((change) => change.kind);
      expect(kinds).toContain("tool.description.changed");
      expect(kinds).not.toContain("server.added");
    },
    TIMEOUT_MS * 4,
  );

  it(
    "is drift when how it is reached changed, and review keeps the pin it cannot replace",
    async () => {
      const root = await workspace();
      await configure(root, { fixture: fixture("base") });
      await run(root, () => runInit(options(root, { allowUnreachable: false })));

      await configure(root, { fixture: { command: process.execPath, args: ["-e", "process.exit(1)"] } });
      const check = await run(root, () => runCheck(options(root)));
      expect(check.result).toBe(EXIT_DRIFT);
      expect(check.output).toContain("server.transport.changed");
      expect(check.output).not.toContain("server.removed");

      const review = await run(root, () => runReview({ ...options(root), acceptAll: true }));
      expect(review.result).toBe(EXIT_DRIFT);
      expect(review.output).toContain("pin is kept");
      const lock = await readLockfile(join(root, "mcp.lock"));
      expect(lock.subjects["fixture"]?.transport).toMatchObject({ args: [SERVER] });
      expect(lock.unaudited).toBeUndefined();
    },
    TIMEOUT_MS * 3,
  );

  it(
    "is drift when the file it runs changed, even though it no longer starts",
    async () => {
      const root = await workspace();
      const script = join(root, "server.mjs");
      await writeFile(script, `await import(${JSON.stringify(pathToFileURL(SERVER).href)});\n`, "utf8");
      await configure(root, { local: { command: process.execPath, args: ["./server.mjs"], env: { NULLADRIFT_FIXTURE_VARIANT: "base" } } });
      await run(root, () => runInit(options(root, { allowUnreachable: false, provenance: true })));
      expect((await readLockfile(join(root, "mcp.lock"))).subjects["local"]?.provenance?.ecosystem).toBe("file");

      // What a pull request would do to make the pinned code something else and keep it from being read.
      await writeFile(script, "process.exit(1);\n", "utf8");
      const check = await run(root, () => runCheck(options(root, { provenance: true })));
      expect(check.result).toBe(EXIT_DRIFT);
      expect(check.output).toContain("server.artifact.changed");
    },
    TIMEOUT_MS * 3,
  );
});
