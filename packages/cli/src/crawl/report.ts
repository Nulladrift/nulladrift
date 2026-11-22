/**
 * Turning crawl history into the number this project exists to find out.
 *
 * Two rates are produced, because they answer different questions and neither alone is honest.
 * Per-comparison ("of the servers checked this run, how many had moved since last time") depends
 * entirely on how often the crawl runs. Per-server-day is comparable across schedules and is the
 * one to quote.
 */
import type { History } from "./state";
import { PERSISTENT_FAILURE_RUNS } from "./state";

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Below this much accumulated observation, no rate is reported at all.
 *
 * Two runs a minute apart over forty servers produce a few server-hours and, with no changes
 * seen, a tidy "0.00 changes per server-year" -- a number with no evidence behind it. Thirty
 * server-days is still thin, but it is enough that the figure means something, and withholding
 * it is better than publishing a confident zero.
 */
export const MIN_SERVER_DAYS = 30;

export interface DriftStats {
  runs: number;
  firstRunAt?: string;
  lastRunAt?: string;
  serversEverSeen: number;
  /** Server-to-server comparisons made across the whole history. */
  comparisons: number;
  driftEvents: number;
  /** Share of comparisons that found a change. Sensitive to crawl frequency. */
  driftPerComparison: number | null;
  /** Total observed time across all servers, in days. */
  serverDays: number;
  /** Changes per server-year, or null until MIN_SERVER_DAYS has accumulated. */
  driftPerServerYear: number | null;
  /** How much more observation is needed before a rate is reported. */
  serverDaysShortfall: number;
  /** Servers that changed at least once. */
  serversEverDrifted: number;
  changeKinds: Record<string, number>;
  protocols: Record<string, number>;
  coverage: {
    remote: number;
    stdioOnly: number;
    stdioSandboxed: number;
    stdioUnsupported: number;
    authRequired: number;
    unreachable: number;
    /** The last run stopped at the paging cap, so its corpus is a prefix of the registry. */
    truncatedCorpus: boolean;
  };
  /**
   * Servers currently failing, split by how long they have been failing.
   *
   * A server that retired months ago and one that blinked once are the same row in a plain
   * unreachable count, and they call for opposite responses: drop the first from the corpus,
   * re-read the second tomorrow.
   */
  failing: { persistent: number; transient: number };
}

export function summarize(history: History): DriftStats {
  const runs = history.runs;
  const last = runs.at(-1);

  let comparisons = 0;
  let driftEvents = 0;
  let serverDays = 0;
  let serversEverDrifted = 0;

  for (const observation of Object.values(history.servers)) {
    comparisons += observation.comparisons;
    driftEvents += observation.driftEvents;
    if (observation.driftEvents > 0) serversEverDrifted += 1;
    // The current like-for-like window, and any a re-baseline closed. See CAPTURE_REVISION.
    const span = Date.parse(observation.lastCheckedAt) - Date.parse(observation.windowStart ?? observation.firstSeenAt);
    if (Number.isFinite(span) && span > 0) serverDays += span / MS_PER_DAY;
    serverDays += observation.priorObservedDays ?? 0;
  }

  let persistent = 0;
  let transient = 0;
  for (const streak of Object.values(history.failures ?? {})) {
    if (streak.consecutive >= PERSISTENT_FAILURE_RUNS) persistent += 1;
    else transient += 1;
  }

  const changeKinds: Record<string, number> = {};
  for (const run of runs) {
    for (const [kind, count] of Object.entries(run.changeKinds)) changeKinds[kind] = (changeKinds[kind] ?? 0) + count;
  }

  return {
    runs: runs.length,
    firstRunAt: runs[0]?.at,
    lastRunAt: last?.at,
    serversEverSeen: Object.keys(history.servers).length,
    comparisons,
    driftEvents,
    driftPerComparison: comparisons > 0 ? driftEvents / comparisons : null,
    serverDays,
    driftPerServerYear: serverDays >= MIN_SERVER_DAYS ? (driftEvents / serverDays) * 365 : null,
    serverDaysShortfall: Math.max(0, MIN_SERVER_DAYS - serverDays),
    serversEverDrifted,
    changeKinds,
    protocols: last?.protocols ?? {},
    coverage: {
      remote: last?.corpus.remote ?? 0,
      stdioOnly: last?.corpus.stdioOnly ?? 0,
      stdioSandboxed: last?.corpus.stdioSandboxed ?? 0,
      stdioUnsupported: last?.corpus.stdioUnsupported ?? 0,
      authRequired: last?.outcomes["auth-required"] ?? 0,
      unreachable: last?.outcomes.unreachable ?? 0,
      truncatedCorpus: last?.corpus.truncated ?? false,
    },
    failing: { persistent, transient },
  };
}

function percent(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "n/a";
}

function table(rows: Array<[string, string]>, headers: [string, string]): string {
  return [`| ${headers[0]} | ${headers[1]} |`, "| --- | ---: |", ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join("\n");
}

export function renderMarkdown(history: History, stats: DriftStats): string {
  const last = history.runs.at(-1);
  const sortedKinds = Object.entries(stats.changeKinds).sort(([, a], [, b]) => b - a);
  const rebaselined = last?.outcomes.rebaselined ?? 0;
  const measured = (last?.outcomes.stable ?? 0) + (last?.outcomes.drifted ?? 0) + (last?.outcomes.baseline ?? 0) + rebaselined;

  const lines = [
    "# MCP capability drift in the wild",
    "",
    "Generated by `pnpm crawl`. Every figure here comes from re-reading the capability surface of",
    "public servers in the MCP registry and diffing it against the previous reading.",
    "",
    "## Headline",
    "",
  ];

  if (stats.comparisons === 0) {
    lines.push(
      "Not enough history yet. The first run only establishes a baseline; a drift rate needs at",
      "least two runs over the same servers.",
      "",
    );
  } else if (stats.driftPerServerYear === null) {
    lines.push(
      `Not enough observation time yet: ${stats.serverDays.toFixed(1)} server-days accumulated, ` +
        `${MIN_SERVER_DAYS} needed before a rate is worth quoting.`,
      "",
      `So far: **${stats.driftEvents} change(s)** across **${stats.comparisons} comparison(s)** over ` +
        `**${stats.serversEverSeen} server(s)**. Keep the crawl running.`,
      "",
    );
  } else {
    lines.push(
      table(
        [
          ["Changes per server-year", stats.driftPerServerYear === null ? "n/a" : stats.driftPerServerYear.toFixed(2)],
          ["Servers that ever changed", `${stats.serversEverDrifted} of ${stats.serversEverSeen} (${percent(stats.serversEverDrifted, stats.serversEverSeen)})`],
          ["Comparisons that found a change", `${stats.driftEvents} of ${stats.comparisons} (${percent(stats.driftEvents, stats.comparisons)})`],
          ["Observation window", `${stats.serverDays.toFixed(1)} server-days over ${stats.runs} run(s)`],
        ],
        ["Measure", "Value"],
      ),
      "",
      "Quote the per-server-year figure. The per-comparison share depends on how often the crawl",
      "runs and is not comparable to anything measured on a different schedule.",
      "",
      "Both are lower bounds. The crawl samples a surface rather than watching it, so two changes",
      "between consecutive readings count once, and a change reverted before the next reading is",
      "not counted at all. The true rate is at least this.",
      "",
    );
  }

  lines.push(
    "## What changed",
    "",
    sortedKinds.length === 0
      ? "_No changes observed yet._"
      : table(
          sortedKinds.map(([kind, count]) => [`\`${kind}\``, String(count)]),
          ["Change kind", "Occurrences"],
        ),
    "",
    "## Coverage, and what it misses",
    "",
    table(
      [
        ["Servers measured in the last run", String(measured)],
        // Read and pinned again, not compared: their baselines came from a collector that recorded less.
        ...(rebaselined > 0 ? ([["\u2003of those, re-baselined after a collector change (not compared)", String(rebaselined)]] as Array<[string, string]>) : []),
        ["Required credentials (not measurable anonymously)", String(stats.coverage.authRequired)],
        ["Unreachable", String(stats.coverage.unreachable)],
        ["stdio packages run in a container", String(stats.coverage.stdioSandboxed)],
        ["stdio packages skipped", String(Math.max(0, stats.coverage.stdioOnly - stats.coverage.stdioSandboxed))],
        ["\u2003of those, unpinned or not an npm package", String(stats.coverage.stdioUnsupported)],
        [`Failing ${PERSISTENT_FAILURE_RUNS}+ runs in a row (treated as gone)`, String(stats.failing.persistent)],
        ["Failing for fewer runs than that (an outage, so far)", String(stats.failing.transient)],
      ],
      ["Population", "Count"],
    ),
    "",
    stats.coverage.stdioSandboxed > 0
      ? "stdio packages were run inside a container with no host mounts, no host environment, no " +
        "privileges, a read-only root and **no network** (`--include-stdio`), each killed after a fixed time. " +
        "Each was fetched first, in a separate container that had the network and ran none of the package's " +
        "code (install scripts off), so a package that needs an install script to work is counted as unreachable."
      : "This run read **remote servers only**. Auditing a stdio entry means executing a third-party " +
        "package; `--include-stdio` does it in a container, and without that flag those entries are " +
        "skipped. Remote servers skew toward hosted and commercial operators, so a remote-only sample " +
        "is not a uniform sample of everything anyone runs.",
    "",
    ...(stats.coverage.truncatedCorpus
      ? [
          "The registry walk in this run **stopped at the paging cap**, so this corpus is a prefix of",
          "the registry rather than the whole of it. These counts are not comparable with a run that",
          "reached the end, and nothing was pruned from the corpus on the strength of it.",
          "",
        ]
      : []),
    "Servers behind a credential are excluded as well: what an anonymous client sees is not what an",
    "authorized one sees, so counting them would mix two different measurements.",
    "",
    "## Protocol revisions in use",
    "",
    Object.keys(stats.protocols).length === 0
      ? "_No successful captures in the last run._"
      : table(
          Object.entries(stats.protocols)
            .sort(([, a], [, b]) => b - a)
            .map(([revision, count]) => [`\`${revision}\``, `${count} (${percent(count, measured)})`]),
          ["Revision", "Servers"],
        ),
    "",
  );

  if (last && last.driftedServers.length > 0) {
    lines.push("## Servers that changed in the latest run", "", ...last.driftedServers.map((name) => `- \`${name}\``), "");
  }

  lines.push(`_Last run: ${stats.lastRunAt ?? "never"}. First run: ${stats.firstRunAt ?? "never"}._`, "");
  return lines.join("\n");
}
