/**
 * The change taxonomy is the contract between the collector, the API and every customer's SARIF
 * consumer, so it lives in shared-types where all three can reach it. This file exists so the
 * engine's own imports stay local, and re-exports it unchanged.
 */
export {
  CHANGE_KINDS,
  SEVERITY,
  SEVERITY_RANK,
  SEVERITIES,
  sortChanges,
  serversThatShippedNothing,
  type Change,
  type ChangeKind,
  type Severity,
} from "../changes";

