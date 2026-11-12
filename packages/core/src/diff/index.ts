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

/**
 * Members grouped by their key, every copy kept.
 *
 * A Map from key to member kept the last of two tools with the same name and dropped the first
 * without a word. A server that listed a poisoned `read_file` ahead of the approved one compared
 * clean: the approved copy was the one compared, and the poisoned one was never looked at. Which
 * copy a client uses is the client's business, so every copy is compared.
 */
function groupBy<T>(members: T[] | undefined, key: (member: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const member of members ?? []) {
    const k = key(member);
    const group = groups.get(k);
    if (group) group.push(member);
    else groups.set(k, [member]);
  }
  return groups;
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
  const previous = groupBy(before, (tool) => tool.name);
  const changes: Change[] = [];

  for (const tool of after ?? []) {
    /*
     * Only tools that were already here. A tool that is new is reported once, by `tool.added`,
     * which names what it can do: raising a second finding for the same fact makes a reviewer
     * read the arrival of one tool twice.
     */
    const existing = previous.get(tool.name);
    if (!existing) continue;
    // Against every copy that was pinned under this name: what any of them could do was approved.
    const had = new Set(existing.flatMap((copy) => toolCapabilities(copy).map((capability) => capability.kind)));
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
   * The digest covers more than the fields called out above -- title, icons, `_meta`, how it may
   * be run. Whichever of those moved is reported, beside any other finding. They used to be
   * reported only when nothing else had fired, so a tool whose title and description changed
   * together showed the description alone: the title a client shows in place of the name changed
   * and nobody was told, and accepting approved it unseen. Found by changing both at once.
   *
   * If none of them moved and nothing else fired, something in the remainder did, and silence
   * would be worse than a vague finding.
   */
  const moved = [
    !same(before.title, after.title) ? "title" : "",
    !same(before.icons, after.icons) ? "icons" : "",
    !same(before.execution, after.execution) ? `how it may be run (${describeExecution(before.execution)} → ${describeExecution(after.execution)})` : "",
    !same(before.meta, after.meta) ? "_meta" : "",
  ].filter(Boolean);
  if (moved.length > 0 || changes.length === 0) {
    changes.push(change("tool.changed", name, `tool definition changed: ${moved.length > 0 ? moved.join(", ") : "a field this report has no finding for"}`, { ...at, before, after }));
  }
  return changes;
}

function describeExecution(execution: LockedTool["execution"]): string {
  const support = execution?.["taskSupport"];
  return typeof support === "string" ? `task support ${support}` : "unstated";
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
  const previous = groupBy(before, spec.key);
  const next = groupBy(after, spec.key);

  for (const [key, members] of next) {
    const existing = previous.get(key);
    if (!existing) {
      for (const member of members) {
        const extra = spec.arriving?.(member);
        changes.push(
          change(spec.added, name, `new ${spec.noun} ${spec.label(member)}${extra ? ` \u00b7 ${extra}` : ""}`, { member: spec.label(member), after: member }),
        );
      }
      continue;
    }

    /*
     * Identical copies pair off first, so a server that reorders its list compares clean. What is
     * left on the new side is compared against what is left on the old one, or, where a copy was
     * added beside the approved one, against the approved one: a second `read_file` is described
     * by how it differs from the first, which is the finding a reviewer needs.
     */
    const unpairedBefore = [...existing];
    const unpairedAfter: T[] = [];
    for (const member of members) {
      const twin = unpairedBefore.findIndex((candidate) => candidate.digest === member.digest);
      if (twin === -1) unpairedAfter.push(member);
      else unpairedBefore.splice(twin, 1);
    }
    for (const [index, member] of unpairedAfter.entries()) {
      const counterpart = unpairedBefore[index] ?? existing[0]!;
      if (counterpart.digest === member.digest) {
        changes.push(
          change(spec.changed, name, `${spec.noun} ${spec.label(member)} is now declared ${members.length} times`, { member: spec.label(member), before: existing, after: members }),
        );
        continue;
      }
      changes.push(
        ...(deep
          ? deep(key, counterpart, member)
          : [change(spec.changed, name, `${spec.noun} ${spec.label(member)} changed`, { member: spec.label(member), before: counterpart, after: member })]),
      );
    }
    for (const member of unpairedBefore.slice(unpairedAfter.length)) {
      changes.push(change(spec.removed, name, `one of the ${spec.noun}s declared as ${spec.label(member)} is gone`, { member: spec.label(member), before: member }));
    }
  }
  for (const [key, members] of previous) {
    if (next.has(key)) continue;
    for (const member of members) changes.push(change(spec.removed, name, `${spec.noun} ${spec.label(member)} is gone`, { member: spec.label(member), before: member }));
  }
  return changes;
}

/**
 * Whether the code behind the server is the code that was pinned.
 *
 * Absence on either side says nothing. A lock written before provenance existed, or a run that
 * could not reach a registry, has none, and reporting that would turn every upgrade of this tool
 * and every offline run into drift against servers nobody touched. Neither does a change of
 * package name: that only happens when the command or its arguments changed, which
 * `server.transport.changed` already reports, and saying it twice is how a reviewer learns to
 * skim.
 */
/** What differs between two lists of a release's files, said briefly, or nothing when they match. */
function filesMoved(was: Record<string, string> | undefined, now: Record<string, string> | undefined): string | undefined {
  if (was === undefined || now === undefined) return undefined;
  const added = Object.keys(now).filter((file) => !Object.hasOwn(was, file));
  const removed = Object.keys(was).filter((file) => !Object.hasOwn(now, file));
  const changed = Object.keys(now).filter((file) => Object.hasOwn(was, file) && was[file] !== now[file]);
  if (added.length + removed.length + changed.length === 0) return undefined;
  const list = (files: string[]) => `${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}`;
  return [
    added.length > 0 ? `added ${list(added)}` : "",
    removed.length > 0 ? `removed ${list(removed)}` : "",
    changed.length > 0 ? `different contents for ${list(changed)}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function compareProvenance(name: string, before: LockedMcpServer, after: LockedMcpServer): Change[] {
  const was = before.provenance;
  const now = after.provenance;
  if (!was || !now) return [];
  if (was.ecosystem !== now.ecosystem || was.name !== now.name) return [];

  const surfaceHeld = before.digest === after.digest;

  /*
   * Said out loud when the surface held still, because that is the case nothing else in the
   * report covers. A release that changed its tools is described by the tool changes; one that
   * changed only its code is described by this line and nothing else.
   */
  const unexplained = surfaceHeld ? ", and the declared surface did not change: nothing else in this report describes what the new code does" : "";
  const integrityMoved = was.integrity !== undefined && now.integrity !== undefined && was.integrity !== now.integrity;

  if (was.version !== undefined && was.version === now.version) {
    if (!integrityMoved) {
      /*
       * The pinned file is one of a release's files, and an installer picks among all of them.
       * A wheel added to the release, or the pinned file taken away, changes what runs without
       * moving `integrity`; when both sides list the release's files, that is compared too.
       */
      const files = filesMoved(was.files, now.files);
      if (files) {
        return [change("server.artifact.changed", name, `the files published for ${was.name}@${was.version} are not the ones that were pinned (${files})${unexplained}`, { before: was, after: now })];
      }
      if (was.integrity !== undefined && now.integrity === undefined) {
        return [change("server.artifact.changed", name, `the file pinned for ${was.name}@${was.version} is no longer published, so something else is installed in its place${unexplained}`, { before: was, after: now })];
      }
      return [];
    }
    /*
     * Substitution is claimed only where the registry guarantees one artifact per version. npm
     * refuses to republish a version, so different bytes under the same one means something
     * between here and the registry served them. PyPI lets a maintainer add files to a release
     * after the fact, so the same version with a different recorded file has an ordinary
     * explanation, and it is reported as the milder kind.
     */
    if (was.ecosystem === "npm") {
      return [
        change(
          "server.artifact.substituted",
          name,
          `${was.name}@${was.version} now has different contents than when it was pinned: the same version, different bytes`,
          { before: was, after: now },
        ),
      ];
    }
    return [change("server.artifact.changed", name, `the files published for ${was.name}@${was.version} are not the ones that were pinned${unexplained}`, { before: was, after: now })];
  }

  if (was.version !== now.version) {
    const moved = `the package behind this server moved from ${was.version ?? "an unknown version"} to ${now.version ?? "an unknown version"}`;
    return [change("server.artifact.changed", name, `${moved}${unexplained}`, { before: was, after: now })];
  }

  /*
   * No version on either side: a file, or an image, whose tag is a pointer rather than a release.
   * A moved tag and a rebuilt binary are both ordinary, so both are the medium kind.
   */
  if (!integrityMoved) return [];
  const what =
    was.ecosystem === "oci"
      ? `the image ${was.name}:${was.requested ?? "latest"} now resolves to a different digest`
      : "the file this server runs from has different contents than when it was pinned";
  return [change("server.artifact.changed", name, `${what}${unexplained}`, { before: was, after: now })];
}

/**
 * What the server digest covers, with each member list taken as a set.
 *
 * Members are stored sorted by name, so copies that share a name keep the order the server sent
 * them in, and a server that swaps two of them moves its digest without changing anything. The
 * member comparison already reads that as clean; this is what lets the fallback below agree.
 *
 * Everything but the fields the digest leaves out is taken as it is, rather than listed, so a
 * field the format gains later is covered here on the day it is added.
 */
function orderless(entry: LockedMcpServer): string {
  const { kind: _kind, source: _source, digest: _digest, provenance: _provenance, coverage: _coverage, tools, resources, resourceTemplates, prompts, ...rest } = entry;
  const digests = (members: Array<{ digest: string }> | undefined) => (members ?? []).map((member) => member.digest).sort();
  return stableKey({
    ...rest,
    tools: digests(tools),
    resources: digests(resources),
    resourceTemplates: digests(resourceTemplates),
    prompts: digests(prompts),
  });
}

function compareServer(name: string, before: LockedMcpServer, after: LockedMcpServer): Change[] {
  /*
   * Provenance first, and outside the short-circuit: the attack it exists for is new code behind
   * an unchanged surface, which is exactly the case where the digests match.
   */
  const provenance = compareProvenance(name, before, after);
  if (before.digest === after.digest) return provenance;
  const changes: Change[] = [...provenance];

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

  /*
   * The digest moved and nothing above says why. Every field the digest covers is compared above,
   * so this should not happen; when it does, a field was missed, and the honest report is a vague
   * finding rather than a clean one. A false clean is the one failure this engine exists to avoid.
   */
  if (changes.length === 0 && orderless(before) !== orderless(after)) {
    changes.push(
      change("server.capabilities.changed", name, "the server's pinned definition changed in a way no other finding describes; compare the lock entries", {
        before: before.digest,
        after: after.digest,
      }),
    );
  }

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
