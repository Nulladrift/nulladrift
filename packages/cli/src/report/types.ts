import type { CapabilityViolation, ServerSteering } from "@nulladrift/core";
import type { Change } from "../diff/types";
import type { FloatingRequest } from "../lock/provenance";

/** A server whose configuration names a registry package with no exact version. */
export interface FloatingServer extends FloatingRequest {
  server: string;
}

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

/** Which of the three it was, in words, wherever a reader is told: the next step differs for each. */
export const AUDIT_FAILURE_LABEL: Record<Unreachable["kind"], string> = {
  auth: "refused the audit",
  forbidden: "accepted the credentials and refused",
  unreachable: "unreachable",
};

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
  /**
   * Servers that answered, but whose artifact could not be established on this run.
   *
   * Never affects the exit code. A registry being down is not the server's fault and must not
   * fail a build; but "the code behind it did not change" and "nobody could look" are different
   * statements, and the report should not let one pass for the other.
   */
  unverified?: string[];
  /**
   * Servers configured to run whatever release their registry has now, with what to write instead.
   *
   * Never affects the exit code. The drift a new release causes is reported, and fails, as drift;
   * this says why it keeps happening, which is the configuration's doing and not the server's.
   */
  floating?: FloatingServer[];
  /**
   * Servers read, but not in full, and why. Fails the audit (exit 2) unless `--allow-partial`,
   * since a clean comparison against part of a surface says nothing about the rest of it.
   */
  partial?: Array<{ server: string; reasons: string[] }>;
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
