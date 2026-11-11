/** Turning what a server sent into the stable, reviewable form the lock stores. */
import { redactPath } from "./credentials";
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

/*
 * Keywords whose value is data rather than a schema. A `required` array inside a `const` or a
 * `default` is part of a value the model is shown, and its order is the server's to choose:
 * sorting it there made `["backup", "delete"]` and `["delete", "backup"]` compare as the same.
 */
const DATA_KEYWORDS = new Set(["const", "default", "enum", "examples", "example"]);
/** Keywords whose value maps names to schemas: the keys are names, never keywords. */
const NAMED_SCHEMAS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/**
 * Sorts the `required` keyword's array. Member order there is semantically insignificant and is
 * the most common source of diffs that mean nothing. Every other array keeps server order,
 * because order *is* significant in `prefixItems`, `allOf` and `icons`, and we only reorder where
 * we can show it is safe.
 *
 * Only where `required` is a keyword: not inside a value (`const`, `default`, `enum`,
 * `examples`), and not as the name of a property, which is a schema of its own.
 */
export function normalizeSchema(value: JsonValue): JsonValue {
  return normalizeNode(value, false);
}

function normalizeNode(value: JsonValue, namesOnly: boolean): JsonValue {
  if (Array.isArray(value)) return value.map((member) => normalizeNode(member, false));
  if (value === null || typeof value !== "object") return value;

  // No prototype, so a member named `__proto__` is kept (see toJson in canonical.ts).
  const out = Object.create(null) as JsonObject;
  for (const [key, member] of Object.entries(value)) {
    if (namesOnly) {
      out[key] = normalizeNode(member, false);
      continue;
    }
    if (key === "required" && Array.isArray(member) && member.every((entry) => typeof entry === "string")) {
      out[key] = [...(member as string[])].sort();
      continue;
    }
    if (DATA_KEYWORDS.has(key)) {
      out[key] = member;
      continue;
    }
    out[key] = normalizeNode(member, NAMED_SCHEMAS.has(key));
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
  /*
   * Bounded twice. A `$ref` already on the way down is not followed again: a definition whose
   * properties point back at it was walked once per property per level, P^12 calls, so a
   * 200-byte schema held `check` for minutes on a blocked event loop that no timeout could
   * interrupt. Headers inside a recursion are the ones its first pass already found. And a hard
   * ceiling on visits, which leaves a marker in the lock rather than an incomplete list that
   * looks complete.
   */
  let budget = MAX_HEADER_VISITS;

  const walk = (node: JsonValue, path: string[], depth: number, refsOnPath: ReadonlySet<string>): void => {
    if (depth > MAX_VISIT_DEPTH) return;
    if (budget <= 0) return;
    budget -= 1;
    const object = effectiveSchema(node, schema);
    if (!object) return;

    const properties = asObject(object["properties"]);
    if (properties) {
      for (const [name, child] of Object.entries(properties)) {
        const resolved = effectiveSchema(child, schema);
        if (!resolved) continue;
        const header = resolved["x-mcp-header"];
        if (typeof header === "string" && header.length > 0) found.push(`${[...path, name].join(".")} -> ${header}`);
        const ref = asObject(child)?.["$ref"];
        if (typeof ref === "string" && refsOnPath.has(ref)) continue;
        walk(child, [...path, name], depth + 1, typeof ref === "string" ? new Set([...refsOnPath, ref]) : refsOnPath);
      }
    }

    // A parameter reachable only through one branch of an `anyOf` is still reachable.
    for (const branch of alternatives(object)) {
      const ref = asObject(branch.schema)?.["$ref"];
      if (typeof ref === "string" && refsOnPath.has(ref)) continue;
      walk(branch.schema, path, depth + 1, typeof ref === "string" ? new Set([...refsOnPath, ref]) : refsOnPath);
    }
  };

  const rootRef = asObject(schema)?.["$ref"];
  walk(schema, [], 0, new Set(typeof rootRef === "string" ? [rootRef] : []));
  if (budget <= 0) found.push(`(schema too large to scan for headers past ${MAX_HEADER_VISITS} nodes)`);
  return [...new Set(found)].sort();
}

/** How many schema nodes the header scan visits before it stops and says so. */
export const MAX_HEADER_VISITS = 20_000;

/** Drops `_meta` keys under any ignored prefix. Returns undefined when nothing is left to pin. */
export function stripIgnoredMeta(meta: JsonValue | undefined, ignoredPrefixes: readonly string[]): JsonObject | undefined {
  if (meta === null || meta === undefined || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const out = Object.create(null) as JsonObject;
  for (const [key, value] of Object.entries(meta)) {
    if (ignoredPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Strips the query string: query strings routinely carry tokens, and the lock is committed. */
export function sanitizeUrl(raw: string): string {
  /*
   * A placeholder (`${HOST}`, `${PORT}`) is kept exactly as written. Parsing first lowercased a
   * placeholder in the host, so the lock named a variable the config never used, and failed on one
   * in the port, which wrote the address raw, query string and all.
   */
  if (raw.includes("${")) return sanitizeText(raw);
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
    // A hosted server whose address embeds the key keeps it in the path, past both of the above.
    url.pathname = redactPath(url.pathname);
    return url.toString();
  } catch {
    return sanitizeText(raw);
  }
}

/** The same, as text, for an address a URL parser cannot or should not normalize. */
function sanitizeText(raw: string): string {
  const withoutUser = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  const base = withoutUser.split(/[?#]/)[0] ?? withoutUser;
  const parts = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i.exec(base);
  return parts ? `${parts[1]}${parts[2] ? redactPath(parts[2]) : ""}` : base;
}
