/**
 * `pnpm crawl` -- measure how often public MCP servers actually change.
 *
 * Deliberately not a `nulladrift` subcommand. The shipped CLI is init / check / review, and this
 * is research infrastructure for answering whether the category is real, not a feature anyone
 * installs.
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { crawl } from "../crawl/run";
import { fetchCorpus } from "../crawl/registry";
import { renderMarkdown, summarize } from "../crawl/report";
import { bold, dim, green, red, yellow } from "../lib/ui";

const { values } = parseArgs({
  options: {
    state: { type: "string", default: "crawl-state" },
    limit: { type: "string" },
    timeout: { type: "string", default: "20000" },
    concurrency: { type: "string", default: "8" },
    delay: { type: "string", default: "50" },
    "host-delay": { type: "string", default: "1000" },
    "include-stdio": { type: "boolean", default: false },
    "sandbox-image": { type: "string" },
    report: { type: "string" },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});

const stateDir = resolve(values.state);
const limit = values.limit === undefined ? undefined : Number.parseInt(values.limit, 10);

if (!values.quiet) process.stderr.write(`${dim("fetching the registry (12k+ entries; this takes a few minutes unless --limit is set)…")}\n`);
const corpus = await fetchCorpus({
  limit,
  onPage: values.quiet
    ? undefined
    : ({ pages, entries, targets }) => process.stderr.write(`\r${dim(`  page ${pages} · ${entries} entries scanned · ${targets} target(s)`)}   `),
  includeStdio: values["include-stdio"],
  ...(values["sandbox-image"] === undefined ? {} : { sandbox: { image: values["sandbox-image"] } }),
});
if (!values.quiet) {
  process.stderr.write("\r".padEnd(78) + "\r");
  if (corpus.stats.truncated) {
    process.stderr.write(`${yellow("registry paging stopped early; this is a partial corpus, not the whole registry.")}\n`);
  }
  process.stderr.write(
    `${dim(
      `${corpus.targets.length} target(s) from ${corpus.stats.latest} current registry entries ` +
        `(${corpus.stats.remote} remote, ${corpus.stats.stdioSandboxed} sandboxed stdio, ` +
        `${corpus.stats.stdioOnly - corpus.stats.stdioSandboxed} stdio skipped)`,
    )}\n`,
  );
}

const MARK = { baseline: dim("·"), stable: green("✓"), drifted: yellow("△"), "auth-required": dim("🔒"), unreachable: red("✗") } as const;

const result = await crawl({
  stateDir,
  corpus,
  timeoutMs: Number.parseInt(values.timeout, 10),
  concurrency: Number.parseInt(values.concurrency, 10),
  delayMs: Number.parseInt(values.delay, 10),
  hostDelayMs: Number.parseInt(values["host-delay"], 10),
  onProgress: values.quiet
    ? undefined
    : (done, total, name, outcome) => {
        process.stderr.write(`\r${dim(`[${String(done).padStart(4)}/${total}]`)} ${MARK[outcome]} ${name.slice(0, 48).padEnd(48)}`);
      },
});
if (!values.quiet) process.stderr.write("\r".padEnd(80) + "\r");

const stats = summarize(result.history);

if (values.json) {
  process.stdout.write(`${JSON.stringify({ run: result.run, stats }, null, 2)}\n`);
} else {
  const { outcomes } = result.run;
  process.stdout.write(
    [
      "",
      bold(`Crawled ${result.run.targets} server(s)`),
      `  ${green(String(outcomes.stable))} unchanged · ${yellow(String(outcomes.drifted))} drifted · ${dim(String(outcomes.baseline))} new baseline`,
      `  ${dim(`${outcomes["auth-required"]} need credentials · ${outcomes.unreachable} unreachable`)}`,
      ...(result.pruned.length > 0
        ? [dim(`  ${result.pruned.length} subject(s) dropped: no longer listed in the registry`), ""]
        : [""]),
      stats.driftPerServerYear === null
        ? dim(
            stats.comparisons === 0
              ? "No rate yet. That needs a second run over the same servers."
              : `No rate yet: ${stats.serverDays.toFixed(1)} server-days observed, ${stats.serverDaysShortfall.toFixed(1)} more needed. ` +
                `So far ${stats.driftEvents} change(s) in ${stats.comparisons} comparison(s).`,
          )
        : `${bold("Drift rate:")} ${stats.driftPerServerYear.toFixed(2)} changes per server-year ` +
          dim(`(${stats.serversEverDrifted}/${stats.serversEverSeen} servers ever changed, ${stats.serverDays.toFixed(1)} server-days observed)`),
      "",
      dim(`State in ${stateDir}`),
      "",
    ].join("\n"),
  );
}

const reportPath = values.report ?? join(stateDir, "drift-report.md");
await writeFile(reportPath, renderMarkdown(result.history, stats), "utf8");
await writeFile(join(stateDir, "drift-report.json"), `${JSON.stringify(stats, null, 2)}\n`, "utf8");
if (!values.quiet) process.stderr.write(`${dim(`report → ${reportPath}`)}\n`);
