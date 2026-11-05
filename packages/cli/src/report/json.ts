/** Machine-readable output. The shape is part of the CLI's contract. */
import { VERSION } from "../lib/version";
import type { ExitCode } from "../lib/exit";
import type { AuditReport } from "./types";

export function renderJsonReport(report: AuditReport, exitCode: ExitCode): string {
  return `${JSON.stringify(
    {
      schema: 1,
      tool: { name: "nulladrift", version: VERSION },
      lockfile: report.lockPath,
      serversChecked: report.serversChecked,
      exitCode,
      summary: {
        drifted: new Set(report.changes.map((change) => change.server)).size,
        changes: report.changes.length,
        unreachable: report.unreachable.length,
      },
      changes: report.changes.map((change) => ({
        kind: change.kind,
        severity: change.severity,
        server: change.server,
        member: change.member,
        summary: change.summary,
        before: change.before,
        after: change.after,
      })),
      unreachable: report.unreachable,
    },
    null,
    2,
  )}\n`;
}
