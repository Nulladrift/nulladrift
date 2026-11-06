/**
 * The findings as a pull request comment.
 *
 * The output of this product is a diff, and diffs are read in pull requests. Until this existed
 * the finding lived in a CI log that goes red with no explanation, or on a dashboard somebody had
 * to leave the review to visit, which is friction at exactly the moment you want none: the person
 * who should read "this tool's description changed" is the one already reading a diff.
 *
 * Written for a reviewer rather than a machine. `renderJsonReport` is for something to act on and
 * `renderSarifReport` is for a code-scanning tab; this is prose with a table, and it says what to
 * do next rather than only what happened.
 */
import { visibleControls } from "../lib/ui";
import { serversThatShippedNothing } from "../diff/types";
import type { Change, Severity } from "../diff/types";
import type { AuditReport } from "./types";

/** Pull request comments say which of the three it was, because the reader's next step differs. */
const AUDIT_FAILURE_LABEL: Record<"auth" | "forbidden" | "unreachable", string> = {
  auth: "refused the audit",
  forbidden: "accepted the credentials and refused",
  unreachable: "unreachable",
};

const MARK: Record<Severity, string> = { high: "🔴", medium: "🟠", low: "⚪" };

/**
 * Markdown escaping for text that came off a server.
 *
 * A tool description is attacker-controlled: it is the field this product exists to watch, and
 * putting it unescaped into a comment would let a server write the comment. Backticks end the
 * code span, pipes break out of the table cell, and the rest of Markdown follows from there.
 */
function cell(text: string): string {
  // Same reasoning as the terminal reporter: this text is written by the server under audit, and
  // a bidirectional override renders a pull request comment as something other than what it says.
  return visibleControls(text).replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/\r?\n/g, " ").trim();
}

function row(change: Change): string {
  const where = change.member ? `${change.server}/${change.member}` : change.server;
  return `| ${MARK[change.severity]} ${change.severity} | \`${cell(where)}\` | ${cell(change.kind)} | ${cell(change.summary)} |`;
}

/**
 * The comment body, or null when there is nothing worth saying.
 *
 * Null rather than "no changes found" on purpose: a bot that comments on every green pull request
 * is a bot people mute, and a muted bot is one nobody reads on the day it matters.
 */
export function renderMarkdownReport(report: AuditReport, options: { url?: string } = {}): string | null {
  if (report.changes.length === 0 && report.unreachable.length === 0) return null;

  const lines: string[] = [];
  const high = report.changes.filter((change) => change.severity === "high").length;

  lines.push(
    high > 0
      ? `### ${report.changes.length} change${report.changes.length === 1 ? "" : "s"} to what your agents can reach, ${high} high`
      : `### ${report.changes.length} change${report.changes.length === 1 ? "" : "s"} to what your agents can reach`,
    "",
    "A server changed what it declares. Same version, same package: the comparison is against the",
    "surface you approved, not the version string.",
    "",
  );

  if (report.changes.length > 0) {
    lines.push("| | Where | What | Detail |", "| --- | --- | --- | --- |", ...report.changes.map(row), "");

    // The absence worth naming: the surface moved and no new version came with it.
    const quiet = serversThatShippedNothing(report.changes);
    if (quiet.length > 0) {
      lines.push(
        `> **${quiet.length === 1 ? "This server" : "These servers"} changed without shipping a new version:** ${quiet
          .map((server) => `\`${cell(server)}\``)
          .join(", ")}`,
        ">",
        "> Same package, same version, a different declaration. Nothing was published.",
        "",
      );
    }
  }

  /*
   * Collapsed, and below the table: it did not decide the verdict and must not read as though it
   * did. A reviewer who opens it is the reader it is for.
   */
  const steering = report.steering ?? [];
  if (steering.length > 0) {
    const total = steering.reduce((sum, server) => sum + server.signals.length, 0);
    lines.push(
      `<details><summary>${total} new passage${total === 1 ? "" : "s"} read as instructions to the model</summary>`,
      "",
      "Text a model is shown, which began addressing it since this lock was approved. A server",
      'documenting "before using this tool, call authenticate first" has the same shape as an',
      "attack, so this is something to read rather than a verdict. It did not affect the result.",
      "",
      "| Server | Field | Passage |",
      "| --- | --- | --- |",
      ...steering.flatMap(({ server, signals }) =>
        signals.slice(0, 10).map((signal) => `| \`${cell(server)}\` | \`${cell(signal.field)}\` | ${cell(signal.quote)} |`),
      ),
      "",
      "</details>",
      "",
    );
  }

  if (report.unreachable.length > 0) {
    // Not a finding and not nothing: an audit that did not happen is not a pass, and the two
    // reasons need telling apart because only one of them is somebody's mistake.
    lines.push(
      `<details><summary>${report.unreachable.length} server${report.unreachable.length === 1 ? "" : "s"} could not be read</summary>`,
      "",
      ...report.unreachable.map(
        (failure) => `- \`${cell(failure.server)}\` · ${AUDIT_FAILURE_LABEL[failure.kind]}: ${cell(failure.reason)}`,
      ),
      "",
      "</details>",
      "",
    );
  }

  lines.push(
    options.url
      ? `Read the full diff and rule on it: ${options.url}`
      : "Run `nulladrift review` to read the full diff, or `nulladrift review --accept-all` to accept every change.",
  );

  return lines.join("\n");
}
