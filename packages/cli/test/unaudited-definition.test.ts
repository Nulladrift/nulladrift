/**
 * What an agreement to leave a server unaudited agrees to, for a server skipped before it was run.
 *
 * A definition this tool would not run -- an `${input:...}` placeholder it cannot fill, a
 * credential it will not hand over, `headersHelper` -- was written into the lock as `{}`, and
 * `check` compared "no transport" with "no transport". So a pull request could rewrite an agreed
 * server to `bash -c "curl ... | sh"`, keep the placeholder, and pass. Found in an audit.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseServerMap } from "../src/config/parsers";
import { runCheck } from "../src/commands/check";
import { runInit } from "../src/commands/init";
import { runReview } from "../src/commands/review";
import type { CommonOptions } from "../src/commands/options";
import { EXIT_CLEAN, EXIT_DRIFT } from "../src/lib/exit";
import { readLockfile, writeLockfile } from "../src/lock/io";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const TIMEOUT_MS = 20_000;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fixture = { command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: "base" } };
/** Needs a value only an editor can supply, so it is never run here. */
const gh = (command: string, args: string[]) => ({ command, args, env: { GH_TOKEN: "${input:ghToken}" } });

async function workspace(servers: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-unaudited-"));
  dirs.push(root);
  await configure(root, servers);
  return root;
}

async function configure(root: string, servers: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
}

function options(root: string, overrides: Partial<CommonOptions> = {}): CommonOptions {
  return { projectRoot: root, lockPath: join(root, "mcp.lock"), configFiles: [], timeoutMs: TIMEOUT_MS, allowUnreachable: true, format: "human", ...overrides };
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

describe("a server skipped before it could be run", () => {
  it(
    "is agreed to as it is written, and rewriting it is drift even with the placeholder kept",
    async () => {
      const root = await workspace({ fixture, gh: gh("npx", ["-y", "@acme/gh-mcp@1.2.0"]) });
      expect((await run(root, () => runInit(options(root)))).result).toBe(EXIT_CLEAN);

      const lock = await readLockfile(join(root, "mcp.lock"));
      expect(lock.unaudited?.["gh"]?.transport).toEqual({ type: "stdio", command: "npx", args: ["-y", "@acme/gh-mcp@1.2.0"], envKeys: ["GH_TOKEN"] });
      expect((await run(root, () => runCheck(options(root)))).result).toBe(EXIT_CLEAN);

      await configure(root, { fixture, gh: gh("bash", ["-c", "echo pwned"]) });
      const check = await run(root, () => runCheck(options(root)));
      expect(check.result).toBe(EXIT_DRIFT);
      expect(check.output).toContain("now reached differently");
    },
    TIMEOUT_MS * 3,
  );

  it(
    "is asked for again, once, when an older lock agreed to it without saying how it is reached",
    async () => {
      const root = await workspace({ fixture, gh: gh("npx", ["-y", "@acme/gh-mcp@1.2.0"]) });
      await run(root, () => runInit(options(root)));
      // What every lock written before this change holds for a server skipped at discovery.
      const older = await readLockfile(join(root, "mcp.lock"));
      await writeLockfile(join(root, "mcp.lock"), { ...older, unaudited: { gh: {} } });

      const check = await run(root, () => runCheck(options(root)));
      expect(check.result).toBe(EXIT_DRIFT);
      expect(check.output).toContain("does not say how it is reached");
      expect(check.output).toContain("nulladrift review");

      expect((await run(root, () => runReview({ ...options(root), acceptAll: true }))).result).toBe(EXIT_CLEAN);
      expect((await readLockfile(join(root, "mcp.lock"))).unaudited?.["gh"]?.transport).toMatchObject({ command: "npx" });
      expect((await run(root, () => runCheck(options(root)))).result).toBe(EXIT_CLEAN);
    },
    TIMEOUT_MS * 4,
  );

  it(
    "cannot be agreed to when how it is reached cannot be read at all",
    async () => {
      const root = await workspace({ fixture, socket: { type: "ws", url: "wss://mcp.example.invalid/ws" } });
      const init = await run(root, () => runInit(options(root)));
      expect(init.output).toContain("cannot be left unaudited");
      expect(await readFile(join(root, "mcp.lock"), "utf8")).not.toContain('"socket"');

      const check = await run(root, () => runCheck(options(root)));
      expect(check.result).toBe(EXIT_DRIFT);
      expect(check.output).toContain("cannot be agreed to");

      // An agreement that says nothing, as an older lock wrote it, matches nothing either.
      const lock = await readLockfile(join(root, "mcp.lock"));
      await writeLockfile(join(root, "mcp.lock"), { ...lock, unaudited: { socket: {} } });
      expect((await run(root, () => runCheck(options(root)))).result).toBe(EXIT_DRIFT);

      // And review does not claim to have agreed to it.
      const review = await run(root, () => runReview({ ...options(root), acceptAll: true }));
      expect(review.output).toContain("not accepted");
      expect((await readLockfile(join(root, "mcp.lock"))).unaudited?.["socket"]).toEqual({});
    },
    TIMEOUT_MS * 4,
  );
});

describe("how a skipped definition is written down", () => {
  const parse = (servers: Record<string, unknown>) =>
    parseServerMap({ mcpServers: servers }, "mcpServers", { client: "claude-code", file: ".mcp.json" }, { workspaceFolder: "/project", env: { NULLADRIFT_TOKEN: "nd_secret" } });

  it("keeps placeholders as written and leaves a literal credential out, like a pinned one", async () => {
    const { skipped } = await parse({
      gh: { command: "docker", args: ["run", "-e", "GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345", "ghcr.io/acme/gh:${input:tag}"], cwd: "tools" },
    });
    expect(skipped[0]?.transport).toEqual({
      type: "stdio",
      command: "docker",
      args: ["run", "-e", "GITHUB_TOKEN=REDACTED", "ghcr.io/acme/gh:${input:tag}"],
      cwd: "tools",
    });
  });

  it("records a remote server refused a credential, and one with a headers helper, by address and header names", async () => {
    const { skipped } = await parse({
      collector: { type: "http", url: "https://mcp.example.com/mcp?key=${NULLADRIFT_TOKEN}", headers: { "X-Org": "acme" } },
      helper: { type: "http", url: "https://mcp.example.com/other", headersHelper: "./get-token.sh" },
    });
    expect(skipped.map((entry) => [entry.serverName, entry.transport])).toEqual([
      ["collector", { type: "http", url: "https://mcp.example.com/mcp", headerKeys: ["X-Org"] }],
      ["helper", { type: "http", url: "https://mcp.example.com/other" }],
    ]);
  });

  it("records nothing for a definition with no transport to read", async () => {
    const { skipped } = await parse({ socket: { type: "ws", url: "wss://x/ws" }, empty: { env: {} }, odd: { args: { not: "a list" } } });
    expect(skipped.map((entry) => entry.transport)).toEqual([undefined, undefined, undefined]);
  });
});
