export * from "./changes";
/**
 * The drift engine, and the model it operates on.
 *
 * This is deliberately a package rather than part of the CLI: the collector computes a diff so a
 * developer sees it locally, and the control plane computes the same diff again from the surface
 * it was sent, because a verdict decided on the machine being audited is a verdict a pull request
 * can edit. Both have to reach the same answer, which means one engine, not two.
 */
export * from "./lock/types";
export { canonicalize, digest, exceedsMaxDepth, MAX_DEPTH, stableKey, toJson } from "./lock/canonical";
export { reseal } from "./lock/reseal";
export {
  extractHeaderParams,
  isEscalation,
  normalizeSchema,
  resolveBehavior,
  sanitizeUrl,
  stripIgnoredMeta,
} from "./lock/normalize";
export { diffLockfiles } from "./diff/index";
export { classifySchemaChange } from "./diff/schema";
export { CHANGE_KINDS, SEVERITY, SEVERITY_RANK, sortChanges, serversThatShippedNothing, type Change, type ChangeKind, type Severity } from "./diff/types";
