import type { CapabilityViolation, ServerSteering } from "@nulladrift/core";
import type { Change } from "../diff/types";

export interface Unreachable {
  server: string;
  reason: string;
  /**
   * Why the audit did not happen, which decides what the operator should do next.
   *
   * - `auth`        no credential was accepted. Obtain one.
   * - `forbidden`   a credential *was* accepted and this identity is still not permitted.
   *                 Obtaining another one changes nothing; the grant or the resource is wrong.
   * - `unreachable` the server did not answer.
   *
   * None of these mean the server was missing, and none of them are drift.
   */
  kind: "auth" | "forbidden" | "unreachable";
}

export interface AuditReport {
  changes: Change[];
  /**
   * Text that began addressing the model since the lock was approved. Never affects the exit
   * code: it is reported beside the verdict, not as part of it.
   */
  steering?: ServerSteering[];
  /**
   * Capabilities the committed policy forbids, found in the surface as it is. Unlike steering
   * these DO decide the verdict: they are derived from schema shape, not matched against prose.
   */
  violations?: CapabilityViolation[];
  /** Servers we could not reach, or configs we could not resolve. Drives exit code 2. */
  unreachable: Unreachable[];
  serversChecked: number;
  lockPath: string;
  /**
   * The project the audit ran in. SARIF locations have to be expressed relative to it: GitHub
   * code scanning resolves `artifactLocation.uri` against the repository root, and an absolute
   * path like `/Users/someone/work/repo/mcp.lock` resolves to nothing, so the alert arrives with
   * no file attached to it.
   */
  projectRoot?: string;
}
