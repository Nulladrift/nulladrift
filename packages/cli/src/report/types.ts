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
  /** Servers we could not reach, or configs we could not resolve. Drives exit code 2. */
  unreachable: Unreachable[];
  serversChecked: number;
  lockPath: string;
}
