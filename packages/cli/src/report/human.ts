/** The default output: what moved, worst first, in language a reviewer can act on. */
import { serversThatShippedNothing } from "../diff/types";
import type { Change, Severity } from "../diff/types";
import { bold, dim, green, red, truncate, yellow } from "../lib/ui";
import type { AuditReport } from "./types";

const MARK: Record<Severity, (text: string) => string> = {
  high: red,
  medium: yellow,
  low: dim,
};

function renderTextChange(before: unknown, after: unknown): string[] {
  const lines: string[] = [];
  if (typeof before === "string") lines.push(`      ${red(`- ${truncate(before)}`)}`);
  if (typeof after === "string") lines.push(`      ${green(`+ ${truncate(after)}`)}`);
  return lines;
}

function renderChange(change: Change): string[] {
  const where = change.member ? `${change.server} › ${change.member}` : change.server;
  const lines = [`  ${MARK[change.severity](change.severity.padEnd(6))} ${bold(where)}  ${dim(change.kind)}`, `      ${change.summary}`];

  // Text that reaches the model is the finding a reviewer most needs to actually read.
  if (change.kind === "tool.description.changed" || change.kind === "server.instructions.changed") {
    lines.push(...renderTextChange(change.before, change.after));
  }
  return lines;
}

export function renderHumanReport(report: AuditReport): string {
  const lines: string[] = [];

  if (report.changes.length > 0) {
    /*
     * "Drift in 1 of 0 server(s)" is what this printed when a server was removed from the config:
     * the drift is real and the denominator is how many were reachable to compare, which is now
     * none. Say that instead of pairing the two numbers as if they were a fraction.
     */
    const drifted = new Set(report.changes.map((change) => change.server)).size;
    const heading =
      report.serversChecked === 0 ? `Drift in ${drifted} server(s), none of which is still configured:` : `Drift in ${drifted} of ${report.serversChecked} server(s):`;
    lines.push("", bold(heading), "");
    for (const change of report.changes) lines.push(...renderChange(change), "");

    /*
     * Said out loud, because it is the sharpest thing in the report and it is an absence.
     * A surface that moved beside a version bump is a release. A surface that moved while the
     * version stayed exactly where it was means nothing was published: same package, same
     * version, different instructions reaching the model.
     */
    const quiet = serversThatShippedNothing(report.changes);
    if (quiet.length > 0) {
      lines.push(
        yellow(`${quiet.length === 1 ? "This server" : "These servers"} changed without shipping a new version:`),
        ...quiet.map((server) => `  ${bold(server)}`),
        "",
      );
    }
  }

  if (report.unreachable.length > 0) {
    lines.push(bold(`Could not audit ${report.unreachable.length} server(s):`), "");
    for (const failure of report.unreachable) {
      const label =
        failure.kind === "auth" ? yellow("needs creds") : failure.kind === "forbidden" ? yellow("not permitted") : red("unreachable");
      lines.push(`  ${label} ${bold(failure.server)}`, `      ${failure.reason}`, "");
    }
  }

  if (report.changes.length === 0 && report.unreachable.length === 0) {
    lines.push(green(`✓ ${report.serversChecked} server(s) match ${report.lockPath}`));
    return `${lines.join("\n")}\n`;
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const change of report.changes) counts[change.severity] += 1;

  if (report.changes.length > 0) {
    lines.push(dim(`${counts.high} high · ${counts.medium} medium · ${counts.low} low`));
    lines.push(dim("Review with `nulladrift review`, or accept everything with `nulladrift review --accept-all`."));
  }
  if (report.unreachable.length > 0) {
    lines.push(dim("A server that cannot be checked fails the audit. Use --allow-unreachable to downgrade that to a warning."));
    if (report.unreachable.some((failure) => failure.kind === "auth")) {
      lines.push(
        dim("`needs creds` means the server would not accept this client, not that it is down. The tool"),
        dim("list a server shows may depend on who is asking, so auditing without credentials would pin"),
        dim("the wrong surface. Run `nulladrift login <server>` once, or set oauth.clientId/clientSecret"),
        dim("for CI."),
      );
    }
    /*
     * Deliberately not the same advice as above. A 403 means the credential was accepted and this
     * identity is still not permitted, so sending somebody back to `login` sends them round a loop
     * they have already been round. The usual cause is a URL that names a tenant the account does
     * not belong to, which no amount of re-authorizing will fix.
     */
    if (report.unreachable.some((failure) => failure.kind === "forbidden")) {
      lines.push(
        dim("`not permitted` means your credentials were accepted and refused. Running `nulladrift login`"),
        dim("again will not change that. Check the server URL for an organization or project you do not"),
        dim("belong to, and whether the grant covers that resource."),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
