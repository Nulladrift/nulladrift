/**
 * Standing rules about what a server may be, as distinct from what changed.
 *
 * Every gate in this product until now has been a gate on movement: something differs from what
 * was approved, so the build fails. That cannot express the rule a security team actually writes
 * down, which is about a property rather than a delta -- *nothing in this repository may execute
 * processes* -- and a rule that can only be checked at the moment of change is not enforced on a
 * repository that never changes.
 *
 * Capability is the right thing to gate on and steering is not. A capability is derived from the
 * shape of the declaration: a `command` argument is a fact about the schema, and the same schema
 * yields the same answer for everyone. A steering signal is a regular expression over prose, and
 * a server documenting "before using this tool, call authenticate first" trips it. Gating on the
 * first is a policy; gating on the second is a coin toss that fails somebody's build.
 *
 * So this exists and the steering equivalent deliberately does not.
 */
import { toolCapabilities, type CapabilityKind, type CapabilitySeverity } from "./capability";
import type { Lockfile } from "../lock/types";

export interface CapabilityViolation {
  server: string;
  tool: string;
  kind: CapabilityKind;
  severity: CapabilitySeverity;
  /** The argument or name the classification was made from, so the rule can be checked. */
  evidence: string;
}

/**
 * Every pinned tool whose capability the policy forbids.
 *
 * Checked against the surface as it is, not against the diff, so a repository whose servers have
 * not moved in a year still fails the day the rule is added. That is the point: the rule is about
 * the surface, and accepting drift cannot make a forbidden capability allowed.
 */
export function capabilityViolations(lock: Lockfile, denied: readonly CapabilityKind[] | undefined): CapabilityViolation[] {
  if (!denied || denied.length === 0) return [];
  const forbidden = new Set<string>(denied);
  const found: CapabilityViolation[] = [];

  for (const [server, subject] of Object.entries(lock.subjects ?? {})) {
    for (const tool of (subject as { tools?: Array<{ name?: string }> }).tools ?? []) {
      for (const capability of toolCapabilities(tool)) {
        if (!forbidden.has(capability.kind)) continue;
        found.push({ server, tool: tool.name ?? "?", kind: capability.kind, severity: capability.severity, evidence: capability.evidence });
      }
    }
  }

  return found.sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool) || a.kind.localeCompare(b.kind));
}
