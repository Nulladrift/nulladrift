/**
 * End to end against a real MCP server over stdio: spawn, negotiate the protocol era, capture,
 * pin, and detect a rug pull. Everything below the CLI's argument parsing runs for real.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { captureAll } from "../src/audit";
import { runCheck } from "../src/commands/check";
import { runInit } from "../src/commands/init";
import { runPush } from "../src/commands/push";
import { runReview } from "../src/commands/review";
import type { CommonOptions } from "../src/commands/options";
import { diffLockfiles } from "../src/diff";
import { EXIT_CLEAN, EXIT_DRIFT, EXIT_INCOMPLETE } from "../src/lib/exit";
import { readLockfile } from "../src/lock/io";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const TIMEOUT_MS = 20_000;

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(servers: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-"));
  workspaces.push(root);
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
  return root;
}

/** HOME is redirected so the developer's own client configs cannot leak into a test. */
async function withIsolatedHome<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  process.env["HOME"] = join(root, "home-that-does-not-exist");
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

function fixtureServer(variant: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: variant }, ...extra };
}

function options(root: string, overrides: Partial<CommonOptions> = {}): CommonOptions {
  return {
    projectRoot: root,
    lockPath: join(root, "mcp.lock"),
    configFiles: [],
    timeoutMs: TIMEOUT_MS,
    allowUnreachable: false,
    format: "human",
    ...overrides,
  };
}

async function capturing<T>(stream: "stdout" | "stderr", run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const target = process[stream];
  const original = target.write.bind(target);
  let output = "";
  target.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof target.write;
  try {
    return { result: await run(), output };
  } finally {
    target.write = original;
  }
}

async function capturingStdout<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  return capturing("stdout", run);
}

/** A refusal is written to stderr, so a test that reads one has to look there. */
async function capturingStderr<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  return capturing("stderr", run);
}

describe("capturing a live server", () => {
  it(
    "negotiates the 2026-07-28 era and pins the whole surface",
    async () => {
      const root = await workspace({ fixture: fixtureServer("base") });
      const { lock, unreachable } = await withIsolatedHome(root, () => captureAll({ projectRoot: root, timeoutMs: TIMEOUT_MS }));

      expect(unreachable).toEqual([]);
      const entry = lock.subjects["fixture"];
      expect(entry?.protocol).toMatchObject({ era: "modern", version: "2026-07-28" });
      expect(entry?.serverInfo).toMatchObject({ name: "fixture-server", version: "1.0.0" });
      expect(entry?.instructions).toContain("inspect source before proposing edits");
      expect(entry?.tools?.map((tool) => tool.name)).toEqual(["read_file", "send_email"]);
      expect(entry?.resources?.map((resource) => resource.name)).toEqual(["readme"]);
      expect(entry?.resourceTemplates?.map((template) => template.uriTemplate)).toEqual(["file:///project/{path}"]);
      expect(entry?.prompts?.map((prompt) => prompt.name)).toEqual(["summarize"]);

      // The read-only tool resolves to no destructive power; send_email keeps what it declared.
      expect(entry?.tools?.find((tool) => tool.name === "read_file")?.behavior).toEqual({
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      });
    },
    TIMEOUT_MS,
  );

  it(
    "falls back to the legacy handshake for a 2025-era server",
    async () => {
      const root = await workspace({ fixture: fixtureServer("legacy") });
      const { lock } = await withIsolatedHome(root, () => captureAll({ projectRoot: root, timeoutMs: TIMEOUT_MS }));
      expect(lock.subjects["fixture"]?.protocol).toMatchObject({ era: "legacy", version: "2025-11-25" });
    },
    TIMEOUT_MS,
  );

  it(
    "reports a server that cannot be spawned rather than pinning nothing silently",
    async () => {
      const root = await workspace({ broken: { command: join(tmpdir(), "no-such-binary") } });
      const { lock, unreachable } = await withIsolatedHome(root, () => captureAll({ projectRoot: root, timeoutMs: 5_000 }));
      expect(Object.keys(lock.subjects)).toEqual([]);
      expect(unreachable[0]?.server).toBe("broken");
    },
    TIMEOUT_MS,
  );
});

describe("init then check", () => {
  it(
    "pins a clean surface and passes, then fails on a rug pull",
    async () => {
      const root = await workspace({ fixture: fixtureServer("base") });

      const init = await capturingStdout(() => withIsolatedHome(root, () => runInit(options(root))));
      expect(init.result).toBe(EXIT_CLEAN);
      expect(init.output).toContain("Pinned 1 server(s)");

      const clean = await capturingStdout(() => withIsolatedHome(root, () => runCheck(options(root))));
      expect(clean.result).toBe(EXIT_CLEAN);

      // Same server name, same command, new behaviour: exactly the shape this tool exists for.
      await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: fixtureServer("drifted") } }, null, 2), "utf8");

      const drifted = await capturingStdout(() => withIsolatedHome(root, () => runCheck(options(root, { format: "json" }))));
      expect(drifted.result).toBe(EXIT_DRIFT);

      const report = JSON.parse(drifted.output) as { changes: Array<{ kind: string; member?: string }> };
      const kinds = report.changes.map((change) => change.kind);

      expect(kinds).toContain("tool.description.changed");
      expect(kinds).toContain("tool.input_schema.widened");
      expect(kinds).toContain("tool.behavior.escalated");
      expect(kinds).toContain("tool.header_params.changed");
      expect(kinds).toContain("server.instructions.changed");
      expect(kinds).toContain("server.identity.changed");
      expect(kinds).toContain("resource_template.added");
    },
    TIMEOUT_MS * 2,
  );

  it(
    "writes a lockfile that holds no credential values",
    async () => {
      const root = await workspace({
        fixture: fixtureServer("base", { env: { NULLADRIFT_FIXTURE_VARIANT: "base", SECRET_TOKEN: "do-not-commit-me" } }),
      });
      await capturingStdout(() => withIsolatedHome(root, () => runInit(options(root))));

      const text = await readFile(join(root, "mcp.lock"), "utf8");
      expect(text).not.toContain("do-not-commit-me");
      expect(text).toContain('"envKeys"');
      expect(text).toContain("SECRET_TOKEN");

      const lock = await readLockfile(join(root, "mcp.lock"));
      expect(lock.subjects["fixture"]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    },
    TIMEOUT_MS,
  );

  it(
    "fails closed on an unreachable server, and only warns with --allow-unreachable",
    async () => {
      const root = await workspace({ fixture: fixtureServer("base") });
      await capturingStdout(() => withIsolatedHome(root, () => runInit(options(root))));

      await writeFile(
        join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { fixture: fixtureServer("base"), gone: { command: "definitely-not-a-real-binary-xyz" } } }, null, 2),
        "utf8",
      );

      const strict = await capturingStdout(() => withIsolatedHome(root, () => runCheck(options(root, { timeoutMs: 5_000 }))));
      expect(strict.result).toBe(EXIT_INCOMPLETE);

      const lenient = await capturingStdout(() =>
        withIsolatedHome(root, () => runCheck(options(root, { timeoutMs: 5_000, allowUnreachable: true }))),
      );
      expect(lenient.result).toBe(EXIT_CLEAN);
    },
    TIMEOUT_MS * 2,
  );

  it(
    "re-pinning an unchanged surface produces byte-identical bytes, so a no-op run makes no diff",
    async () => {
      const root = await workspace({ fixture: fixtureServer("base") });
      await capturingStdout(() => withIsolatedHome(root, () => runInit(options(root))));
      const first = await readFile(join(root, "mcp.lock"), "utf8");

      // --force, or the second run refuses and this compares a file nobody rewrote against itself.
      const again = await capturingStdout(() => withIsolatedHome(root, () => runInit({ ...options(root), force: true })));
      expect(again.result).toBe(EXIT_CLEAN);
      expect(await readFile(join(root, "mcp.lock"), "utf8")).toBe(first);
    },
    TIMEOUT_MS * 2,
  );
});

describe("init over an existing lock", () => {
  it(
    "refuses, rather than quietly re-baselining a lock somebody reviewed",
    async () => {
      const root = await workspace({ fixture: fixtureServer("base") });
      await capturingStdout(() => withIsolatedHome(root, () => runInit(options(root))));

      // Unreviewed drift is on the wire: this is the moment a second `init` would bury it.
      await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: fixtureServer("drifted") } }, null, 2), "utf8");

      const refused = await capturingStderr(() => withIsolatedHome(root, () => runInit(options(root))));
      expect(refused.result).toBe(EXIT_INCOMPLETE);
      expect(refused.output).toContain("already exists");
      expect(refused.output).toContain("nulladrift review");

      // The baseline still says what it said, so the drift is still there for `check` to find.
      expect((await readLockfile(join(root, "mcp.lock"))).subjects["fixture"]?.serverInfo?.version).toBe("1.0.0");
      expect((await capturingStdout(() => withIsolatedHome(root, () => runCheck(options(root))))).result).toBe(EXIT_DRIFT);
    },
    TIMEOUT_MS * 3,
  );

  it(
    "re-pins from scratch with --force",
    async () => {
      const root = await workspace({ fixture: fixtureServer("base") });
      await capturingStdout(() => withIsolatedHome(root, () => runInit(options(root))));
      await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: fixtureServer("drifted") } }, null, 2), "utf8");

      const forced = await capturingStdout(() => withIsolatedHome(root, () => runInit({ ...options(root), force: true })));
      expect(forced.result).toBe(EXIT_CLEAN);
      expect((await readLockfile(join(root, "mcp.lock"))).subjects["fixture"]?.serverInfo?.version).toBe("2.0.0");
    },
    TIMEOUT_MS * 2,
  );
});

describe("review", () => {
  it(
    "accepts drift into the lock, after which check passes again",
    async () => {
      const root = await workspace({ fixture: fixtureServer("base") });
      await capturingStdout(() => withIsolatedHome(root, () => runInit(options(root))));

      await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: fixtureServer("drifted") } }, null, 2), "utf8");
      expect((await capturingStdout(() => withIsolatedHome(root, () => runCheck(options(root))))).result).toBe(EXIT_DRIFT);

      const review = await capturingStdout(() => withIsolatedHome(root, () => runReview({ ...options(root), acceptAll: true })));
      expect(review.result).toBe(EXIT_CLEAN);
      expect(review.output).toContain("accepted 1 server(s)");

      expect((await capturingStdout(() => withIsolatedHome(root, () => runCheck(options(root))))).result).toBe(EXIT_CLEAN);

      const lock = await readLockfile(join(root, "mcp.lock"));
      expect(lock.subjects["fixture"]?.serverInfo?.version).toBe("2.0.0");
    },
    TIMEOUT_MS * 3,
  );

  it(
    "refuses to prompt when there is no terminal, rather than silently accepting",
    async () => {
      const root = await workspace({ fixture: fixtureServer("base") });
      await capturingStdout(() => withIsolatedHome(root, () => runInit(options(root))));
      await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: fixtureServer("drifted") } }, null, 2), "utf8");

      // vitest runs without a TTY, which is the condition under test.
      const result = await capturingStdout(() => withIsolatedHome(root, () => runReview({ ...options(root), acceptAll: false })));
      expect(result.result).toBe(EXIT_INCOMPLETE);
      expect((await readLockfile(join(root, "mcp.lock"))).subjects["fixture"]?.serverInfo?.version).toBe("1.0.0");
    },
    TIMEOUT_MS * 2,
  );
});

describe("a server that stops answering", () => {
  it(
    "times out instead of hanging the audit",
    async () => {
      const root = await workspace({ fixture: fixtureServer("silent") });
      const { unreachable } = await withIsolatedHome(root, () => captureAll({ projectRoot: root, timeoutMs: 1_500 }));
      expect(unreachable[0]?.server).toBe("fixture");
    },
    TIMEOUT_MS,
  );

  /*
   * `--timeout` is documented as a per-server timeout and was applied per request. Capturing a
   * surface takes several, so a server that accepts a connection and never answers held the
   * audit for two and a half to three times the configured value: `--timeout 2000` measured
   * 6.1s, `--timeout 4000` measured 10.1s. At the 30s default that is a minute and a half that
   * a server nobody controls gets to decide.
   *
   * The bound is generous because it is a timing assertion, and the point is the multiple: two
   * and a half times the budget fails this, and the budget plus teardown passes.
   */
  it(
    "spends the configured budget once, not once per request",
    async () => {
      const root = await workspace({ fixture: fixtureServer("silent") });
      const budget = 1_500;
      const started = Date.now();
      const { unreachable } = await withIsolatedHome(root, () => captureAll({ projectRoot: root, timeoutMs: budget }));
      const elapsed = Date.now() - started;

      expect(unreachable[0]?.server).toBe("fixture");
      expect(elapsed).toBeLessThan(budget * 2);
    },
    TIMEOUT_MS,
  );
});

describe("the lock is diffed, not just hashed", () => {
  it(
    "shows the injected sentence in the diff of two captures",
    async () => {
      const baseRoot = await workspace({ fixture: fixtureServer("base") });
      const driftRoot = await workspace({ fixture: fixtureServer("drifted") });

      const base = await withIsolatedHome(baseRoot, () => captureAll({ projectRoot: baseRoot, timeoutMs: TIMEOUT_MS }));
      const drifted = await withIsolatedHome(driftRoot, () => captureAll({ projectRoot: driftRoot, timeoutMs: TIMEOUT_MS }));

      const description = diffLockfiles(base.lock, drifted.lock).find((change) => change.kind === "tool.description.changed");
      expect(String(description?.after)).toContain(".aws/credentials");
    },
    TIMEOUT_MS * 2,
  );
});

describe("pushing from a project with nothing to audit", () => {
  /*
   * The control plane refuses an empty reading, correctly, with "a reading has to contain at
   * least one server or one failure". That is a sentence about a request body, written for
   * whoever is debugging the API, and it was what somebody saw after running the collector in a
   * directory with no client config: it never says that none was found, or where the collector
   * looked. `init` has said both for as long as it has existed.
   */
  it("says so itself, naming where it looked, instead of letting the server refuse it", async () => {
    const root = await workspace({});

    const { result, output } = await capturingStderr(() =>
      withIsolatedHome(root, () =>
        runPush({ ...options(root), apiUrl: "http://control-plane.invalid", token: "ndft_not_used", project: "web" }),
      ),
    );

    expect(output).toContain("No MCP servers found");
    expect(output).toContain("Looked in:");
    /*
     * The host is unroutable on purpose. Reaching it would fail with a DNS or connection error
     * rather than this message, so a passing assertion here is also proof that nothing was sent.
     */
    expect(output).not.toContain("control-plane.invalid");
    /*
     * Incomplete rather than clean, which is where push parts company with init: a gate that
     * passes because it found nothing to check is how a project quietly stops being audited.
     */
    expect(result).toBe(EXIT_INCOMPLETE);
  });
});
