import type { Change } from "../diff/types";

export interface Unreachable {
  server: string;
  reason: string;
  /** "auth" means the audit was refused, not that the server was missing. */
  kind: "auth" | "unreachable";
}

export interface AuditReport {
  changes: Change[];
  /** Servers we could not reach, or configs we could not resolve. Drives exit code 2. */
  unreachable: Unreachable[];
  serversChecked: number;
  lockPath: string;
}
