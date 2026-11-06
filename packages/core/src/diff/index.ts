/** Comparing a freshly captured lock against the committed one. */
import { stableKey } from "../lock/canonical";
import { isEscalation } from "../lock/normalize";
import type {
  LockedPrompt,
  LockedResource,
  LockedResourceTemplate,
  LockedMcpServer,
  LockedTool,
  Lockfile,
} from "../lock/types";
import { toolCapabilities, type CapabilitySeverity } from "../risk/capability";
import { classifySchemaChange } from "./schema";
import type { Change, ChangeKind, Severity } from "./types";
import { SEVERITY, sortChanges } from "./types";

function change(kind: ChangeKind, server: string, summary: string, extra?: Partial<Change>): Change {
  return { kind, severity: SEVERITY[kind], server, summary, ...extra };
}

function same(a: unknown, b: unknown): boolean {
  return stableKey(a ?? null) === stableKey(b ?? null);
}

function indexBy<T>(members: T[] | undefined, key: (member: T) => string): Map<string, T> {
  return new Map((members ?? []).map((member) => [key(member), member]));
}

/**
 * What a server declares, flattened so that an extension is one of the names.
 *
 * `capabilities` is a handful of top-level keys, and one of them, `extensions`, is a map of
 * reverse-DNS ids: that is the mechanism the specification uses to ship capability outside the
 * core. Comparing only the top level means a server that gains an extension still has
 * `extensions` before and after, so nothing reads as gained and the finding lands on the generic
 * "declared capabilities changed" with the detail left inside a JSON blob for a reviewer to go
 * and read. As more of what a server can do arrives as an extension, "what did this one just
 * gain" becomes an extension question, and it deserves an answer in words.
 *
 * The `extensions` key itself is not a name. Reporting both it and the id it contains would say
 * the same thing twice on the reading where a server declares its first extension.
 */
function declaredNames(capabilities: LockedMcpServer["capabilities"]): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(capabilities ?? {})) {
    if (key === "extensions" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const id of Object.keys(value)) names.push(`extensions/${id}`);
      continue;
    }
    names.push(key);
  }
  return names;
}

/** Describes the delta between two capability maps in the direction that matters. */
function compareCapabilities(before: LockedMcpServer, after: LockedMcpServer, name: string): Change[] {
  if (same(before.capabilities, after.capabilities)) return [];
  const previous = declaredNames(before.capabilities);
  const next = declaredNames(after.capabilities);
  const gained = next.filter((key) => !previous.includes(key));
  const lost = previous.filter((key) => !next.includes(key));

  if (gained.length > 0 && lost.length === 0) {
    return [change("server.capabilities.widened", name, `server now declares ${gained.join(", ")}`, { before: before.capabilities, after: after.capabilities })];
  }
  if (lost.length > 0 && gained.length === 0) {
    return [change("server.capabilities.narrowed", name, `server no longer declares ${lost.join(", ")}`, { before: before.capabilities, after: after.capabilities })];
  }
  return [change("server.capabilities.changed", name, "declared capabilities changed", { before: before.capabilities, after: after.capabilities })];
}


/*
 * What a tool can do, compared across a reading.
 *
 * The schema diff says a tool "accepts input it did not before", which is the same sentence
 * whether the new argument is `nickname` or `command`. The classifier already knows the
 * difference and says so at pin time; the diff did not ask, so the finding a reviewer approved
 * described arbitrary command execution in the words of an optional string.
 *
 * A tool that is new is compared against nothing, so everything it can do is gained. That is the
 * honest reading: a server that adds a tool taking `command` has gained command execution just as
 * surely as one that adds the argument to a tool already there.
 */
const CAPABILITY_SEVERITY: Record<CapabilitySeverity, Severity> = {
  critical: "high",
  high: "high",
  medium: "medium",
  low: "low",
};

function compareToolCapabilities(server: string, before: LockedTool[] | undefined, after: LockedTool[] | undefined): Change[] {
  const previous = indexBy(before, (tool) => tool.name);
  const changes: Change[] = [];

  for (const tool of after ?? []) {
    /*
     * Only tools that were already here. A tool that is new is reported once, by `tool.added`,
     * which names what it can do: raising a second finding for the same fact makes a reviewer
     * read the arrival of one tool twice.
     */
    const existing = previous.get(tool.name);
    if (!existing) continue;
    const had = new Set(toolCapabilities(existing).map((capability) => capability.kind));
    for (const capability of toolCapabilities(tool)) {
      if (had.has(capability.kind)) continue;
      changes.push(
        change("tool.capability.gained", server, `can now ${capability.kind} (${capability.evidence})`, {
          member: tool.name,
          severity: CAPABILITY_SEVERITY[capability.severity],
          after: { kind: capability.kind, severity: capability.severity, evidence: capability.evidence },
        }),
      );
    }
  }
  return changes;
}

function compareTool(name: string, before: LockedTool, after: LockedTool): Change[] {
  if (before.digest === after.digest) return [];
  const changes: Change[] = [];
  const at = { member: before.name };

  if (!same(before.description, after.description)) {
    changes.push(
      change("tool.description.changed", name, `description changed (${before.description?.length ?? 0} → ${after.description?.length ?? 0} characters)`, {
        ...at,
        before: before.description,
        after: after.description,
      }),
    );
  }

  const inputVerdict = classifySchemaChange(before.inputSchema, after.inputSchema);
  if (inputVerdict !== "same") {
    const kind = (`tool.input_schema.${inputVerdict}` satisfies ChangeKind) as ChangeKind;
    const wording = inputVerdict === "widened" ? "accepts input it did not before" : inputVerdict === "narrowed" ? "accepts less input than before" : "input schema changed";
    changes.push(change(kind, name, wording, { ...at, before: before.inputSchema, after: after.inputSchema }));
  }

  if (!same(before.outputSchema, after.outputSchema)) {
    changes.push(change("tool.output_schema.changed", name, "output schema changed", { ...at, before: before.outputSchema, after: after.outputSchema }));
  }

  if (!same(before.behavior, after.behavior)) {
    const escalated = isEscalation(before.behavior, after.behavior);
    changes.push(
      change(escalated ? "tool.behavior.escalated" : "tool.behavior.relaxed", name, escalated ? describeEscalation(before, after) : "declares fewer powers than before", {
        ...at,
        before: before.behavior,
        after: after.behavior,
      }),
    );
  }

  if (!same(before.headerParams, after.headerParams)) {
    changes.push(
      change("tool.header_params.changed", name, "arguments mirrored into HTTP headers changed", { ...at, before: before.headerParams ?? [], after: after.headerParams ?? [] }),
    );
  }

  /*
   * The digest covers more than the fields called out above -- title, icons, `_meta`. If none of
   * them fired, something in that remainder moved, and silence would be worse than a vague
   * finding.
   */
  if (changes.length === 0) {
    changes.push(change("tool.changed", name, "tool definition changed (title, icons or _meta)", { ...at, before, after }));
  }
  return changes;
}

function describeEscalation(before: LockedTool, after: LockedTool): string {
  const gained: string[] = [];
  if (before.behavior.readOnly && !after.behavior.readOnly) gained.push("may now modify");
  if (!before.behavior.destructive && after.behavior.destructive) gained.push("may now destroy");
  if (before.behavior.idempotent && !after.behavior.idempotent) gained.push("repeat calls now compound");
  if (!before.behavior.openWorld && after.behavior.openWorld) gained.push("may now reach external systems");
  return gained.join("; ");
}

interface MemberSpec<T> {
  key: (member: T) => string;
  label: (member: T) => string;
  added: ChangeKind;
  removed: ChangeKind;
  changed: ChangeKind;
  noun: string;
  /** Extra wording for a member that is new, where arriving is itself the finding. */
  arriving?: (member: T) => string;
}

function compareMembers<T extends { digest: string }>(
  name: string,
  before: T[] | undefined,
  after: T[] | undefined,
  spec: MemberSpec<T>,
  deep?: (key: string, a: T, b: T) => Change[],
): Change[] {
  const changes: Change[] = [];
  const previous = indexBy(before, spec.key);
  const next = indexBy(after, spec.key);

  for (const [key, member] of next) {
    const existing = previous.get(key);
    if (!existing) {
      const extra = spec.arriving?.(member);
      changes.push(
        change(spec.added, name, `new ${spec.noun} ${spec.label(member)}${extra ? ` \u00b7 ${extra}` : ""}`, { member: spec.label(member), after: member }),
      );
      continue;
    }
    if (existing.digest === member.digest) continue;
    changes.push(...(deep ? deep(key, existing, member) : [change(spec.changed, name, `${spec.noun} ${spec.label(member)} changed`, { member: spec.label(member), before: existing, after: member })]));
  }
  for (const [key, member] of previous) {
    if (!next.has(key)) changes.push(change(spec.removed, name, `${spec.noun} ${spec.label(member)} is gone`, { member: spec.label(member), before: member }));
  }
  return changes;
}

function compareServer(name: string, before: LockedMcpServer, after: LockedMcpServer): Change[] {
  if (before.digest === after.digest) return [];
  const changes: Change[] = [];

  if (!same(before.transport, after.transport)) {
    changes.push(change("server.transport.changed", name, "the server is reached differently than when it was pinned", { before: before.transport, after: after.transport }));
  }
  if (!same(before.serverInfo, after.serverInfo)) {
    const from = before.serverInfo?.version ?? "unknown";
    const to = after.serverInfo?.version ?? "unknown";
    changes.push(change("server.identity.changed", name, `server identity changed (version ${from} → ${to})`, { before: before.serverInfo, after: after.serverInfo }));
  }
  if (!same(before.protocol, after.protocol)) {
    changes.push(
      change("server.protocol.changed", name, `protocol changed (${before.protocol.era}/${before.protocol.version} → ${after.protocol.era}/${after.protocol.version})`, {
        before: before.protocol,
        after: after.protocol,
      }),
    );
  }
  if (!same(before.instructions, after.instructions)) {
    changes.push(
      change("server.instructions.changed", name, "server instructions changed: this text goes into the model's system prompt", {
        before: before.instructions,
        after: after.instructions,
      }),
    );
  }
  changes.push(...compareCapabilities(before, after, name));

  changes.push(
    ...compareMembers<LockedTool>(name, before.tools, after.tools, {
      key: (t) => t.name,
      label: (t) => t.name,
      added: "tool.added",
      removed: "tool.removed",
      changed: "tool.changed",
      noun: "tool",
      arriving: (t) => {
        const can = toolCapabilities(t);
        return can.length > 0 ? `can ${can.map((capability) => capability.kind).join(", ")}` : "";
      },
    }, (_key, a, b) =>
      compareTool(name, a, b),
    ),
  );
  changes.push(...compareToolCapabilities(name, before.tools, after.tools));
  changes.push(
    ...compareMembers<LockedResource>(name, before.resources, after.resources, {
      key: (r) => r.uri,
      label: (r) => `${r.name} (${r.uri})`,
      added: "resource.added",
      removed: "resource.removed",
      changed: "resource.changed",
      noun: "resource",
    }),
  );
  changes.push(
    ...compareMembers<LockedResourceTemplate>(name, before.resourceTemplates, after.resourceTemplates, {
      key: (t) => t.uriTemplate,
      // The template itself is the capability -- widening it from file:///project/{path} to
      // file:///{path} is the whole finding -- so it belongs in the label, not just the body.
      label: (t) => `${t.name} (${t.uriTemplate})`,
      added: "resource_template.added",
      removed: "resource_template.removed",
      changed: "resource_template.changed",
      noun: "resource template",
    }),
  );
  changes.push(
    ...compareMembers<LockedPrompt>(name, before.prompts, after.prompts, {
      key: (p) => p.name,
      label: (p) => p.name,
      added: "prompt.added",
      removed: "prompt.removed",
      changed: "prompt.changed",
      noun: "prompt",
    }),
  );

  return changes;
}

/**
 * A server renamed in config would naively read as a removal plus an addition: two alarming
 * findings for a cosmetic edit. Collapsing requires an identical transport *and* an identical
 * digest, so a rename that also changed capabilities stays a remove and an add -- which is what
 * it is, and hiding a capability change inside a cosmetic one is the failure mode worth avoiding.
 */
function detectRenames(before: Lockfile, after: Lockfile, removed: string[], added: string[]): { changes: Change[]; renamed: Set<string> } {
  const changes: Change[] = [];
  const renamed = new Set<string>();
  const availableAdds = [...added];

  for (const oldName of removed) {
    const oldEntry = before.subjects[oldName];
    if (!oldEntry) continue;
    const match = availableAdds.find((newName) => {
      const candidate = after.subjects[newName];
      return candidate !== undefined && candidate.digest === oldEntry.digest && same(candidate.transport, oldEntry.transport);
    });
    if (!match) continue;

    availableAdds.splice(availableAdds.indexOf(match), 1);
    renamed.add(oldName);
    renamed.add(match);
    changes.push(change("server.renamed", match, `renamed from "${oldName}"; capabilities are unchanged`, { before: oldName, after: match }));
  }
  return { changes, renamed };
}

export function diffLockfiles(before: Lockfile, after: Lockfile): Change[] {
  const beforeNames = Object.keys(before.subjects);
  const afterNames = Object.keys(after.subjects);
  const removed = beforeNames.filter((name) => !afterNames.includes(name));
  const added = afterNames.filter((name) => !beforeNames.includes(name));

  const { changes: renameChanges, renamed } = detectRenames(before, after, removed, added);
  const changes: Change[] = [...renameChanges];

  for (const name of added) {
    if (renamed.has(name)) continue;
    const entry = after.subjects[name];
    const toolCount = entry?.tools?.length ?? 0;
    changes.push(change("server.added", name, `new server with ${toolCount} tool${toolCount === 1 ? "" : "s"}`, { after: entry }));
  }
  for (const name of removed) {
    if (renamed.has(name)) continue;
    changes.push(change("server.removed", name, "server is no longer configured", { before: before.subjects[name] }));
  }
  for (const name of afterNames) {
    const a = before.subjects[name];
    const b = after.subjects[name];
    if (!a || !b) continue;
    changes.push(...compareServer(name, a, b));
  }

  return sortChanges(changes);
}
