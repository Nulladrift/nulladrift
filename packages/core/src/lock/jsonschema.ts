/**
 * Just enough JSON Schema to see through the indirection servers actually use.
 *
 * Two parts of this tool have to look inside a tool's `inputSchema`: the widening heuristic and
 * the `x-mcp-header` scan. Both used to read only the literal node in front of them, so a schema
 * that put its properties behind `$ref` or `allOf` -- which the generators for Pydantic, Zod and
 * most OpenAPI toolchains do by default -- looked empty to both. A widened parameter went out as
 * a bare `.changed`, and a parameter newly mirrored into an HTTP header was missed entirely.
 *
 * This is not a validator. It resolves local `$ref`, flattens `allOf`, and leaves the
 * alternation keywords for the caller to branch on. Remote `$ref` is never fetched: an audit
 * that reaches out to a URL named by the thing it is auditing is not an audit.
 */
import type { JsonObject, JsonValue } from "./types";

/** Depth caps. A hostile or merely recursive schema must not be able to hang the run. */
export const MAX_REF_DEPTH = 32;
export const MAX_VISIT_DEPTH = 12;
export const MAX_FACTS = 5_000;
/**
 * Nodes one call may merge. A ceiling on total work, where the depth caps only bound how far down
 * one path goes; see `effectiveSchema`.
 */
export const MAX_RESOLUTIONS = 100_000;

/*
 * What each `$ref` resolves to, per schema root. Without it, `allOf: [{$ref: next} x4]` at each of
 * sixteen levels resolved `next` once per path to it: 4^16 resolutions for an 1.8 KB schema,
 * synchronously, after the server had answered, so no timeout could stop it. A definition means
 * the same thing wherever it is referenced from, so it is resolved once.
 */
interface ResolutionState {
  refs: Map<string, JsonObject | undefined>;
  spent: number;
}
const states = new WeakMap<object, ResolutionState>();

function stateOf(root: JsonValue): ResolutionState {
  if (root === null || typeof root !== "object") return { refs: new Map(), spent: 0 };
  let state = states.get(root);
  if (!state) {
    state = { refs: new Map(), spent: 0 };
    states.set(root, state);
  }
  return state;
}

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

/** RFC 6901 token decoding: `~1` is `/` and `~0` is `~`, in that order. */
function decodeToken(token: string): string {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    // A malformed escape is a literal, not a reason to abandon the schema.
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolves a local JSON pointer. Anything with a non-empty URI part is left unresolved. */
export function resolvePointer(root: JsonValue, ref: string): JsonValue | undefined {
  if (!ref.startsWith("#")) return undefined;
  const pointer = ref.slice(1);
  if (pointer !== "" && !pointer.startsWith("/")) return undefined; // `#anchor`, which needs an anchor index.

  let node: JsonValue | undefined = root;
  for (const token of pointer.split("/").slice(1)) {
    const object = asObject(node);
    if (object === undefined) return undefined;
    node = object[decodeToken(token)];
  }
  return node;
}

/**
 * The keywords in effect at a node, with `$ref` followed and `allOf` folded in.
 *
 * The node's own keywords win over anything it inherits, `properties` are unioned, and
 * `required` is the union of every contributor -- which is what `allOf` means. Alternation
 * (`anyOf` / `oneOf` / `then` / `else`) is deliberately left in place: a caller that wants to
 * treat branches as separate possibilities can, and one that does not is no worse off.
 */
export function effectiveSchema(node: JsonValue | undefined, root: JsonValue, seenRefs: ReadonlySet<string> = new Set(), depth = 0): JsonObject | undefined {
  const object = asObject(node);
  if (object === undefined) return undefined;
  if (depth > MAX_REF_DEPTH) return object;
  const state = stateOf(root);
  if (depth === 0) state.spent = 0;
  // Past the budget, a node is taken as written. Less precise, and never unbounded.
  if (++state.spent > MAX_RESOLUTIONS) return object;

  /*
   * No prototype, and own-property checks rather than `in`. `name in merged` on a plain object is
   * true for `constructor`, `toString` and `__proto__`, so a property with one of those names was
   * skipped as already merged, and `merged["__proto__"] = ...` set the prototype instead.
   */
  const out = Object.create(null) as JsonObject;
  const merge = (source: JsonObject): void => {
    for (const [key, value] of Object.entries(source)) {
      if (key === "$ref" || key === "allOf") continue;
      if (key === "properties") {
        // First contributor wins on a conflict, and keeps its position: the merged object reads
        // in the order a person wrote it, not inside-out from the inheritance chain.
        const merged = Object.assign(Object.create(null) as JsonObject, asObject(out["properties"]) ?? {});
        for (const [name, schema] of Object.entries(asObject(value) ?? {})) {
          if (!Object.hasOwn(merged, name)) Object.defineProperty(merged, name, { value: schema, enumerable: true, writable: true, configurable: true });
        }
        out["properties"] = merged;
      } else if (key === "required" && Array.isArray(value)) {
        const already = Array.isArray(out["required"]) ? (out["required"] as JsonValue[]) : [];
        out["required"] = [...new Set([...already, ...value].filter((entry): entry is string => typeof entry === "string"))];
      } else if (!Object.hasOwn(out, key)) {
        out[key] = value;
      }
    }
  };

  // The node itself first, so its own keywords take precedence over what it inherits.
  merge(object);

  const ref = object["$ref"];
  if (typeof ref === "string" && !seenRefs.has(ref)) {
    let resolved: JsonObject | undefined;
    if (state.refs.has(ref)) resolved = state.refs.get(ref);
    else {
      resolved = effectiveSchema(resolvePointer(root, ref), root, new Set([...seenRefs, ref]), depth + 1);
      state.refs.set(ref, resolved);
    }
    if (resolved) merge(resolved);
  }

  const allOf = object["allOf"];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      const resolved = effectiveSchema(branch, root, seenRefs, depth + 1);
      if (resolved) merge(resolved);
    }
  }

  return out;
}

/** The alternation branches at a node, labelled so a caller can key facts by them. */
export function alternatives(object: JsonObject): Array<{ label: string; schema: JsonValue }> {
  const branches: Array<{ label: string; schema: JsonValue }> = [];
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const value = object[keyword];
    if (!Array.isArray(value)) continue;
    value.forEach((schema, index) => branches.push({ label: `${keyword}[${index}]`, schema }));
  }
  for (const keyword of ["then", "else", "not"] as const) {
    if (object[keyword] !== undefined) branches.push({ label: keyword, schema: object[keyword] as JsonValue });
  }
  return branches;
}
