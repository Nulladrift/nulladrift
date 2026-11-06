/**
 * The change taxonomy: the one vocabulary the collector, the API, the dashboard and every
 * customer's SARIF consumer share.
 *
 * It lives here rather than in the CLI because it is a contract across process boundaries. A
 * collector on an old version reports a kind the server has to understand, and a renamed kind
 * breaks a SARIF rule id somebody has already suppressed. Renaming one is a major version.
 */

export const CHANGE_KINDS = [
  "server.added",
  "server.removed",
  "server.renamed",
  "server.transport.changed",
  "server.identity.changed",
  "server.protocol.changed",
  "server.instructions.changed",
  "server.capabilities.widened",
  "server.capabilities.narrowed",
  "server.capabilities.changed",
  "tool.added",
  "tool.removed",
  "tool.description.changed",
  "tool.input_schema.widened",
  "tool.input_schema.narrowed",
  "tool.input_schema.changed",
  "tool.output_schema.changed",
  "tool.behavior.escalated",
  "tool.behavior.relaxed",
  "tool.header_params.changed",
  "tool.capability.gained",
  "tool.changed",
  "resource.added",
  "resource.removed",
  "resource.changed",
  "resource_template.added",
  "resource_template.removed",
  "resource_template.changed",
  "prompt.added",
  "prompt.removed",
  "prompt.changed",
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * Ranking only. Every kind is drift; severity decides what a reviewer reads first, what SARIF
 * level an AppSec tool shows, and which changes a policy can be set to block. "high" is reserved
 * for shapes an attacker would use -- text that reaches the model, a widened input, a new power --
 * so that it keeps meaning something.
 */
export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY: Record<ChangeKind, Severity> = {
  "server.added": "medium",
  "server.removed": "low",
  "server.renamed": "low",
  "server.transport.changed": "high",
  "server.identity.changed": "medium",
  "server.protocol.changed": "medium",
  "server.instructions.changed": "high",
  "server.capabilities.widened": "medium",
  "server.capabilities.narrowed": "low",
  "server.capabilities.changed": "medium",
  "tool.added": "high",
  "tool.removed": "low",
  "tool.description.changed": "high",
  "tool.input_schema.widened": "high",
  "tool.input_schema.narrowed": "low",
  "tool.input_schema.changed": "medium",
  "tool.output_schema.changed": "medium",
  "tool.behavior.escalated": "high",
  "tool.behavior.relaxed": "low",
  "tool.header_params.changed": "high",
  /*
   * Severity is set per change rather than read from here: what a tool gained decides it. A
   * `command` argument is not the same finding as a `url` one, and flattening both to one number
   * is how "accepts input it did not before" came to describe arbitrary command execution.
   */
  "tool.capability.gained": "high",
  "tool.changed": "medium",
  "resource.added": "medium",
  "resource.removed": "low",
  "resource.changed": "medium",
  "resource_template.added": "high",
  "resource_template.removed": "low",
  "resource_template.changed": "high",
  "prompt.added": "medium",
  "prompt.removed": "low",
  "prompt.changed": "medium",
};

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** One change, as the collector reports it and as the dashboard renders it. */
export interface Change {
  kind: ChangeKind;
  severity: Severity;
  /** Name of the server in the lock. */
  server: string;
  /** Tool, resource, template or prompt name, where the change is scoped to one. */
  member?: string;
  /** One line, written for a reviewer who has not read the lockfile. */
  summary: string;
  before?: unknown;
  after?: unknown;
}

export function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.server.localeCompare(b.server) ||
      (a.member ?? "").localeCompare(b.member ?? "") ||
      a.kind.localeCompare(b.kind),
  );
}

/**
 * Which servers moved without shipping anything.
 *
 * A surface that changes alongside a version bump is a release: somebody published something,
 * and the change is attributable to it. A surface that changes while the version stays exactly
 * where it was is the opposite, and it is the shape this product exists for: the same package,
 * the same version, a different set of instructions reaching the model.
 *
 * Both halves are already recorded. `server.identity.changed` carries the version move, so the
 * signal is the *absence* of one beside other changes, and a reviewer currently has to notice a
 * thing that is not there. This names it so a report can say it out loud.
 *
 * It lives beside the taxonomy rather than in the engine because it reasons about a list of
 * changes and nothing else: the dashboard asks the same question and has no business depending
 * on a diff engine to do it.
 */
export function serversThatShippedNothing(changes: readonly Change[]): string[] {
  const moved = new Set<string>();
  const versioned = new Set<string>();
  for (const change of changes) {
    moved.add(change.server);
    if (change.kind === "server.identity.changed") versioned.add(change.server);
  }
  return [...moved].filter((server) => !versioned.has(server)).sort();
}
