/** Turning what a server sent into the stable, reviewable form the lock stores. */
import { alternatives, asObject, effectiveSchema, MAX_VISIT_DEPTH } from "./jsonschema";
import type { JsonObject, JsonValue, LockedAnnotations, LockedBehavior } from "./types";

/**
 * Resolves the four behavioural annotations against the spec's defaults, which are not neutral:
 * an absent `readOnlyHint` means "may modify" and an absent `destructiveHint` means "may
 * destroy". A server deleting an annotation is therefore an escalation, and the lock has to be
 * able to show it as a changed value rather than a removed line. See docs/lockfile.md §4.
 *
 * `destructiveHint` and `idempotentHint` are defined to be meaningful only when `readOnlyHint`
 * is false, so a read-only tool resolves to non-destructive and idempotent regardless of what
 * it claims: a tool that changes nothing cannot destroy anything, and repeating it has no
 * additional effect.
 */
export function resolveBehavior(annotations: LockedAnnotations | undefined): LockedBehavior {
  const readOnly = annotations?.readOnlyHint ?? false;
  return {
    readOnly,
    destructive: readOnly ? false : (annotations?.destructiveHint ?? true),
    idempotent: readOnly ? true : (annotations?.idempotentHint ?? false),
    openWorld: annotations?.openWorldHint ?? true,
  };
}

/** True when `next` claims any power `previous` did not. */
export function isEscalation(previous: LockedBehavior, next: LockedBehavior): boolean {
  return (
    (previous.readOnly && !next.readOnly) ||
    (!previous.destructive && next.destructive) ||
    (previous.idempotent && !next.idempotent) ||
    (!previous.openWorld && next.openWorld)
  );
}

/**
 * Sorts `required` arrays wherever they appear. Member order there is semantically
 * insignificant and is the most common source of diffs that mean nothing. Every other array
 * keeps server order, because order *is* significant in `prefixItems`, `allOf` and `icons`, and
 * we only reorder where we can show it is safe.
 *
 * The rule is positional rather than schema-aware: a non-schema object with a string-array
 * member literally named `required` would also be sorted. That costs nothing we can observe and
 * avoids carrying a JSON Schema interpreter around.
 */
export function normalizeSchema(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (value === null || typeof value !== "object") return value;

  const out: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === "required" && Array.isArray(member) && member.every((entry) => typeof entry === "string")) {
      out[key] = [...(member as string[])].sort();
      continue;
    }
    out[key] = normalizeSchema(member);
  }
  return out;
}

/**
 * Finds input properties carrying an `x-mcp-header` annotation, which mirrors the argument's
 * value into an `Mcp-Param-*` HTTP header on Streamable HTTP, where proxies and WAFs can read
 * it. A server adding this to an existing parameter redirects that argument's data with no
 * visible change to the tool's signature, so it gets its own line in the lock.
 *
 * `$ref` and `allOf` are resolved first. Schema generators put properties behind `$defs` as a
 * matter of course, and a scan that only read literal nodes found nothing in those -- which is
 * the worst outcome for a field whose entire purpose is to move data somewhere new.
 */
export function extractHeaderParams(schema: JsonValue): string[] {
  const found: string[] = [];

  const walk = (node: JsonValue, path: string[], depth: number): void => {
    if (depth > MAX_VISIT_DEPTH) return;
    const object = effectiveSchema(node, schema);
    if (!object) return;

    const properties = asObject(object["properties"]);
    if (properties) {
      for (const [name, child] of Object.entries(properties)) {
        const resolved = effectiveSchema(child, schema);
        if (!resolved) continue;
        const header = resolved["x-mcp-header"];
        if (typeof header === "string" && header.length > 0) found.push(`${[...path, name].join(".")} -> ${header}`);
        walk(child, [...path, name], depth + 1);
      }
    }

    // A parameter reachable only through one branch of an `anyOf` is still reachable.
    for (const branch of alternatives(object)) walk(branch.schema, path, depth + 1);
  };

  walk(schema, [], 0);
  return [...new Set(found)].sort();
}

/** Drops `_meta` keys under any ignored prefix. Returns undefined when nothing is left to pin. */
export function stripIgnoredMeta(meta: JsonValue | undefined, ignoredPrefixes: readonly string[]): JsonObject | undefined {
  if (meta === null || meta === undefined || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(meta)) {
    if (ignoredPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Strips the query string: query strings routinely carry tokens, and the lock is committed. */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    /*
     * `https://alice:s3cr3t@host/mcp` survived this untouched, because `toString()` keeps
     * userinfo. The query string was stripped on the grounds that credentials usually sit there;
     * userinfo is the one place a credential sits by definition.
     */
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Not a parseable URL. Keep it as configured so the mismatch is visible rather than silent.
    return raw;
  }
}
