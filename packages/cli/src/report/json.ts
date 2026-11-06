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
        /*
         * Counted separately from `changes` because it is not part of the verdict. A consumer
         * that gates on this field is gating on a regex, which is the thing this must never be.
         */
        steering: (report.steering ?? []).reduce((sum, server) => sum + server.signals.length, 0),
        /** Unlike steering, these DO decide the exit code. */
        violations: (report.violations ?? []).length,
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
      /** Text that began addressing the model since the lock was approved. Reported, never gated. */
      steering: report.steering ?? [],
      violations: report.violations ?? [],
    },
    null,
    2,
  )}\n`;
}
