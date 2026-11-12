/**
 * The crawl: the instrument for "how often does this actually happen". Its job is to produce a
 * number that is honest, so most of what is tested here is when it refuses to produce one.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredServer } from "../src/config/types";
import { crawl } from "../src/crawl/run";
import { MIN_SERVER_DAYS, renderMarkdown, summarize } from "../src/crawl/report";
import type { Corpus, CrawlTarget } from "../src/crawl/registry";
import type { History } from "../src/crawl/state";
import { PRUNE_AFTER_ABSENT_RUNS } from "../src/crawl/state";
import { readLockfile } from "../src/lock/io";
import { corpusFile, readCorpus } from "../src/crawl/corpus";
import { isAuthFailure, UnreachableServerError } from "../src/mcp/types";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const DAY = 24 * 60 * 60 * 1_000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mcp-crawl-"));
  dirs.push(path);
  return path;
}

function target(name: string, variant: string): ConfiguredServer {
  return {
    name,
    source: { client: "manual", file: "test" },
    transport: { type: "stdio", command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: variant } },
  };
}

function corpusOf(targets: CrawlTarget[], truncated = false): Corpus {
  return {
    targets,
    stats: { latest: targets.length, remote: targets.length, stdioOnly: 0, stdioSandboxed: 0, stdioUnsupported: 0, truncated },
  };
}

const UNREACHABLE: ConfiguredServer["transport"] = { type: "stdio", command: join(tmpdir(), "not-a-real-binary-xyz"), args: [], env: {} };

function broken(name: string): ConfiguredServer {
  return { name, source: { client: "manual", file: "test" }, transport: UNREACHABLE };
}

describe("isAuthFailure", () => {
  it("separates a credential wall from an outage", () => {
    expect(isAuthFailure(new UnreachableServerError("s", "HTTP 401 Unauthorized"))).toBe(true);
    expect(isAuthFailure(new UnreachableServerError("s", "invalid or missing MCP token"))).toBe(true);
    expect(isAuthFailure(new UnreachableServerError("s", "connect ECONNREFUSED"))).toBe(false);
    expect(isAuthFailure(new UnreachableServerError("s", "spawn ENOENT"))).toBe(false);
  });

  // A server's error message is the server's to write; this one held the audit for two minutes.
  it("reads a hostile megabyte of error text in well under a second", () => {
    const started = performance.now();
    expect(isAuthFailure(new UnreachableServerError("s", "invalid or missing ".repeat(65_000)))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("a crawl over time", () => {
  it(
    "baselines, then compares, then records drift",
    async () => {
      const state = await stateDir();

      const first = await crawl({ stateDir: state, corpus: corpusOf([target("alpha", "base")]), now: new Date(T0), timeoutMs: 20_000 });
      expect(first.run.outcomes).toMatchObject({ baseline: 1, stable: 0, drifted: 0 });
      expect(first.changes).toEqual([]);

      const second = await crawl({ stateDir: state, corpus: corpusOf([target("alpha", "base")]), now: new Date(T0 + 40 * DAY), timeoutMs: 20_000 });
      expect(second.run.outcomes).toMatchObject({ baseline: 0, stable: 1, drifted: 0 });

      const third = await crawl({ stateDir: state, corpus: corpusOf([target("alpha", "drifted")]), now: new Date(T0 + 80 * DAY), timeoutMs: 20_000 });
      expect(third.run.outcomes).toMatchObject({ stable: 0, drifted: 1 });
      expect(third.run.driftedServers).toEqual(["alpha"]);
      expect(Object.keys(third.run.changeKinds)).toContain("tool.description.changed");

      const observation = third.history.servers["alpha"];
      expect(observation).toMatchObject({ comparisons: 2, driftEvents: 1 });
      expect(observation?.protocol).toBe("modern/2026-07-28");
    },
    120_000,
  );

  it(
    "does not report an unreachable server as a removal",
    async () => {
      const state = await stateDir();
      await crawl({ stateDir: state, corpus: corpusOf([target("alpha", "base")]), now: new Date(T0), timeoutMs: 20_000 });

      const second = await crawl({ stateDir: state, corpus: corpusOf([broken("alpha")]), now: new Date(T0 + DAY), timeoutMs: 5_000 });

      // A server we could not reach is absent from the fresh snapshot. Diffing the whole corpus
      // would call that `server.removed` -- drift that says nothing about the server.
      expect(second.changes).toEqual([]);
      expect(second.run.outcomes.unreachable).toBe(1);

      // And its pinned entry survives, so a transient outage does not discard the baseline.
      const lock = await readCorpus(state);
      expect(lock.subjects["alpha"]?.tools?.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "keeps the corpus in the product's own format, one lockfile per server",
    async () => {
      const state = await stateDir();
      await crawl({ stateDir: state, corpus: corpusOf([target("alpha", "base"), target("beta", "base")]), now: new Date(T0), timeoutMs: 20_000 });

      for (const name of ["alpha", "beta"]) {
        const text = await readFile(join(state, corpusFile(name)), "utf8");
        // No timestamps: a server that did not change must leave its file byte-for-byte alone.
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
        expect(Object.keys((await readLockfile(join(state, corpusFile(name)))).subjects)).toEqual([name]);
      }
      expect(Object.keys((await readCorpus(state)).subjects).sort()).toEqual(["alpha", "beta"]);
    },
    120_000,
  );

  it(
    "tries the other endpoints an entry advertises before calling the server unreachable",
    async () => {
      const state = await stateDir();
      // The shape of a registry entry that lists a dead SSE endpoint ahead of a working one.
      const withFallback: CrawlTarget = {
        ...broken("alpha"),
        alternates: [{ type: "stdio", command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: "base" } }],
      };

      const result = await crawl({ stateDir: state, corpus: corpusOf([withFallback]), now: new Date(T0), timeoutMs: 20_000 });

      expect(result.run.outcomes).toMatchObject({ baseline: 1, unreachable: 0 });
      const lock = await readCorpus(state);
      expect(lock.subjects["alpha"]?.tools?.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "counts consecutive failures, and forgets them on the next success",
    async () => {
      const state = await stateDir();

      await crawl({ stateDir: state, corpus: corpusOf([broken("alpha")]), now: new Date(T0), timeoutMs: 5_000 });
      const twice = await crawl({ stateDir: state, corpus: corpusOf([broken("alpha")]), now: new Date(T0 + DAY), timeoutMs: 5_000 });

      // A tally cannot tell a server that retired in March from one that blinked this morning.
      expect(twice.history.failures["alpha"]).toMatchObject({ consecutive: 2, kind: "unreachable" });

      const recovered = await crawl({ stateDir: state, corpus: corpusOf([target("alpha", "base")]), now: new Date(T0 + 2 * DAY), timeoutMs: 20_000 });
      expect(recovered.history.failures["alpha"]).toBeUndefined();
    },
    120_000,
  );

  it(
    "drops a delisted subject, but only after a week of absences",
    async () => {
      const state = await stateDir();
      await crawl({ stateDir: state, corpus: corpusOf([target("alpha", "base")]), now: new Date(T0), timeoutMs: 20_000 });

      let last = await crawl({ stateDir: state, corpus: corpusOf([]), now: new Date(T0 + DAY) });
      for (let run = 2; run < PRUNE_AFTER_ABSENT_RUNS; run += 1) {
        last = await crawl({ stateDir: state, corpus: corpusOf([]), now: new Date(T0 + run * DAY) });
        expect(last.pruned).toEqual([]);
      }
      // Still pinned on the last run before the threshold: a short walk is not a delisting.
      expect((await readCorpus(state)).subjects["alpha"]).toBeDefined();
      expect(last.history.absent["alpha"]).toBe(PRUNE_AFTER_ABSENT_RUNS - 1);

      const final = await crawl({ stateDir: state, corpus: corpusOf([]), now: new Date(T0 + PRUNE_AFTER_ABSENT_RUNS * DAY) });
      expect(final.pruned).toEqual(["alpha"]);
      expect((await readCorpus(state)).subjects["alpha"]).toBeUndefined();

      // The observation survives the snapshot: it is the record the all-time rate is built from.
      expect(final.history.servers["alpha"]).toBeDefined();
    },
    120_000,
  );

  it(
    "prunes nothing on a truncated walk, where absence means the paging stopped",
    async () => {
      const state = await stateDir();
      await crawl({ stateDir: state, corpus: corpusOf([target("alpha", "base")]), now: new Date(T0), timeoutMs: 20_000 });

      for (let run = 1; run <= PRUNE_AFTER_ABSENT_RUNS + 2; run += 1) {
        const result = await crawl({ stateDir: state, corpus: corpusOf([], true), now: new Date(T0 + run * DAY) });
        expect(result.pruned).toEqual([]);
      }

      expect((await readCorpus(state)).subjects["alpha"]).toBeDefined();
    },
    120_000,
  );
});

describe("summarize", () => {
  const history = (servers: History["servers"], runs: History["runs"] = []): History => ({
    version: 1,
    runs,
    servers,
    failures: {},
    absent: {},
  });

  it("withholds a rate until enough observation has accumulated", () => {
    const thin = summarize(
      history({ a: { firstSeenAt: new Date(T0).toISOString(), lastCheckedAt: new Date(T0 + 60_000).toISOString(), comparisons: 1, driftEvents: 0 } }),
    );
    // Two runs a minute apart would otherwise yield a confident "0.00 per server-year".
    expect(thin.driftPerServerYear).toBeNull();
    expect(thin.serverDaysShortfall).toBeGreaterThan(0);
  });

  it("reports a rate once the window is wide enough", () => {
    const wide = summarize(
      history({
        a: { firstSeenAt: new Date(T0).toISOString(), lastCheckedAt: new Date(T0 + 365 * DAY).toISOString(), comparisons: 12, driftEvents: 3 },
      }),
    );
    expect(wide.serverDays).toBeCloseTo(365, 0);
    expect(wide.driftPerServerYear).toBeCloseTo(3, 1);
    expect(wide.driftPerComparison).toBeCloseTo(0.25, 2);
    expect(wide.serversEverDrifted).toBe(1);
  });

  it("sums observation across servers, so breadth substitutes for duration", () => {
    const servers: History["servers"] = {};
    for (let i = 0; i < MIN_SERVER_DAYS + 5; i += 1) {
      servers[`s${i}`] = { firstSeenAt: new Date(T0).toISOString(), lastCheckedAt: new Date(T0 + DAY).toISOString(), comparisons: 1, driftEvents: 0 };
    }
    expect(summarize(history(servers)).driftPerServerYear).toBe(0);
  });
});

describe("renderMarkdown", () => {
  const run = {
    at: new Date(T0).toISOString(),
    targets: 10,
    outcomes: { baseline: 0, stable: 8, drifted: 2, "auth-required": 3, unreachable: 1 },
    changeKinds: { "tool.description.changed": 2 },
    protocols: { "legacy/2025-11-25": 7, "modern/2026-07-28": 1 },
    corpus: { latest: 20, remote: 14, stdioOnly: 6, stdioSandboxed: 0, stdioUnsupported: 2, truncated: false },
    driftedServers: ["one", "two"],
  };

  const observed = (days: number, comparisons: number, driftEvents: number): History["servers"] => ({
    one: { firstSeenAt: new Date(T0).toISOString(), lastCheckedAt: new Date(T0 + days).toISOString(), comparisons, driftEvents },
  });

  it("says what it cannot measure, not just what it did", () => {
    const history: History = { version: 1, runs: [run], servers: observed(200 * DAY, 10, 2), failures: {}, absent: {} };
    const text = renderMarkdown(history, summarize(history));

    expect(text).toContain("remote servers only");
    expect(text).toContain("Required credentials");
    expect(text).toContain("stdio packages");
    expect(text).toContain("legacy/2025-11-25");
    expect(text).toMatch(/changes per server-year/i);
    // The entries no sandbox could express are a coverage gap, not a rounding error.
    expect(text).toContain("unpinned or not an npm package");
  });

  it("calls the rate a lower bound, because sampling cannot see a change that was reverted", () => {
    const history: History = { version: 1, runs: [run], servers: observed(200 * DAY, 10, 2), failures: {}, absent: {} };
    expect(renderMarkdown(history, summarize(history))).toContain("lower bounds");
  });

  it("separates a server that has been failing for weeks from one that failed once", () => {
    const history: History = {
      version: 1,
      runs: [run],
      servers: observed(200 * DAY, 10, 2),
      failures: {
        gone: { consecutive: 9, kind: "unreachable", firstFailedAt: new Date(T0).toISOString(), lastFailedAt: new Date(T0 + 9 * DAY).toISOString() },
        blinked: { consecutive: 1, kind: "unreachable", firstFailedAt: new Date(T0).toISOString(), lastFailedAt: new Date(T0).toISOString() },
      },
      absent: {},
    };
    const stats = summarize(history);

    expect(stats.failing).toEqual({ persistent: 1, transient: 1 });
    expect(renderMarkdown(history, stats)).toMatch(/treated as gone/);
  });

  it("says when the registry walk stopped early, so the counts are not read as the whole registry", () => {
    const history: History = {
      version: 1,
      runs: [{ ...run, corpus: { ...run.corpus, truncated: true } }],
      servers: observed(200 * DAY, 10, 2),
      failures: {},
      absent: {},
    };
    expect(renderMarkdown(history, summarize(history))).toContain("stopped at the paging cap");
  });

  it("refuses to print a rate it cannot support", () => {
    const history: History = { version: 1, runs: [run], servers: observed(60_000, 1, 0), failures: {}, absent: {} };
    const text = renderMarkdown(history, summarize(history));
    expect(text).toContain("Not enough observation time yet");
    expect(text).not.toMatch(/changes per server-year/i);
  });
});
