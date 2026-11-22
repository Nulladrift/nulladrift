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
import { canonicalize } from "./canonical";
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
/**
 * Keys every call against one schema may copy between them. `MAX_RESOLUTIONS` is per call, and a
 * walk makes a call for every node it reaches; see `effectiveSchema`. The largest of 92,512 tool
 * schemas in the public registry crawl copies 6,550 keys across the header scan, the capability
 * scan and the widening heuristic together, so this is fifteen times anything published.
 */
export const MAX_MERGED_KEYS = 100_000;

/*
 * What each `$ref` resolves to, per schema root. Without it, `allOf: [{$ref: next} x4]` at each of
 * sixteen levels resolved `next` once per path to it: 4^16 resolutions for an 1.8 KB schema,
 * synchronously, after the server had answered, so no timeout could stop it. A definition means
 * the same thing wherever it is referenced from, so it is resolved once.
 *
 * The same holds one level up, for a node. See `effectiveSchema`.
 */
interface ResolutionState {
  refs: Map<string, JsonObject | undefined>;
  nodes: WeakMap<object, JsonObject>;
  spent: number;
  /** Keys copied by every call against this root. Never reset. */
  merged: number;
}
const states = new WeakMap<object, ResolutionState>();

function freshState(): ResolutionState {
  return { refs: new Map(), nodes: new WeakMap(), spent: 0, merged: 0 };
}

/**
 * Starts a walk of `root` with nothing remembered and the whole budget.
 *
 * Every reader that walks a schema starts here, so what one of them spent cannot change what the
 * next one sees. The budget is per schema, and the collector runs the header scan on the very
 * object a fresh reading is later compared with: a budget the scan had used up made the two sides
 * of a comparison read a hostile schema differently, which is a verdict an attacker can steer.
 */
export function beginWalk(root: JsonValue): void {
  if (root !== null && typeof root === "object") states.delete(root);
}

function stateOf(root: JsonValue): ResolutionState {
  if (root === null || typeof root !== "object") return freshState();
  let state = states.get(root);
  if (!state) {
    state = freshState();
    states.set(root, state);
  }
  return state;
}

/*
 * Keywords `allOf` combines by intersecting rather than by letting one contributor win. Every
 * branch of an `allOf` applies, so `allOf: [{maxLength: 100}, {maxLength: 5}]` accepts five
 * characters. Taking the first made relaxing the second invisible, and a widening read as a
 * narrowing. Found in a security review.
 */
const LOWER_BOUNDS = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties", "minContains"]);
const UPPER_BOUNDS = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties", "maxContains"]);
/** Keywords that describe rather than constrain: a second value of one changes nothing that is accepted. */
const ANNOTATIONS = new Set(["title", "description", "default", "examples", "example", "$comment", "$id", "$schema", "$anchor", "deprecated", "readOnly", "writeOnly"]);

/**
 * What `allOf` said that one object cannot hold: a second `pattern`, a second schema for the same
 * property. Kept beside the effective schema rather than in it, so a reader that wants only the
 * merged view -- the header scan, whose answer is part of a tool's digest -- reads what it always
 * read, and the widening heuristic can still see a constraint come or go.
 */
export interface Shadowed {
  keywords: Map<string, JsonValue[]>;
  properties: Map<string, JsonValue[]>;
}
const shadows = new WeakMap<JsonObject, Shadowed>();

export function shadowedIn(effective: JsonObject): Shadowed | undefined {
  return shadows.get(effective);
}

function remember(into: Map<string, JsonValue[]>, key: string, value: JsonValue): void {
  const held = into.get(key);
  if (held) held.push(value);
  else into.set(key, [value]);
}

function canonicalOrUndefined(value: JsonValue): string | undefined {
  try {
    return canonicalize(value);
  } catch {
    return undefined;
  }
}

/** Members of `held` that are also in `value`, compared as JSON rather than by identity. */
function intersectEnum(held: JsonValue[], value: JsonValue[]): JsonValue[] {
  const allowed = new Set(value.map(canonicalOrUndefined));
  return held.filter((member) => allowed.has(canonicalOrUndefined(member)));
}

/** The types both accept. `integer` is a `number`, so the two meet at `integer`. */
function intersectTypes(held: JsonValue, value: JsonValue): JsonValue {
  const list = (types: JsonValue): Set<string> | undefined =>
    typeof types === "string" ? new Set([types]) : Array.isArray(types) ? new Set(types.filter((entry): entry is string => typeof entry === "string")) : undefined;
  const a = list(held);
  const b = list(value);
  if (a === undefined || b === undefined) return held;
  const both = [...a].filter((type) => b.has(type) || (type === "integer" && b.has("number")));
  if (a.has("number") && b.has("integer") && !both.includes("integer")) both.push("integer");
  return both.length === 1 ? (both[0] as string) : both;
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
 * `required` is the union of every contributor -- which is what `allOf` means. Bounds, `enum` and
 * `type` are intersected, for the same reason; anything else a later contributor says differently
 * is kept aside (see `shadowedIn`). Alternation (`anyOf` / `oneOf` / `then` / `else`) is
 * deliberately left in place: a caller that wants to treat branches as separate possibilities
 * can, and one that does not is no worse off.
 *
 * The result is shared: callers read it and never write to it.
 */
export function effectiveSchema(node: JsonValue | undefined, root: JsonValue, seenRefs: ReadonlySet<string> = new Set(), depth = 0): JsonObject | undefined {
  const object = asObject(node);
  if (object === undefined) return undefined;
  if (depth > MAX_REF_DEPTH) return object;
  const state = stateOf(root);
  /*
   * Worked out once per node. Every walk asks for the effective schema of each child of each node
   * it reaches, and a child written `{"$ref": "#"}` merged the whole root every time it was asked:
   * a root of 800 such properties is 16 KB, the header scan asked 800 x 800 times, and each answer
   * copied 800 properties -- 87 seconds of `init` on a blocked event loop. A node means the same
   * thing wherever it is reached from, as a definition does.
   */
  if (depth === 0) {
    const known = state.nodes.get(object);
    if (known !== undefined) return known;
    state.spent = 0;
  }
  // Past the budget, a node is taken as written. Less precise, and never unbounded.
  if (++state.spent > MAX_RESOLUTIONS || state.merged > MAX_MERGED_KEYS) {
    if (depth === 0) state.nodes.set(object, object);
    return object;
  }

  /*
   * No prototype, and own-property checks rather than `in`. `name in merged` on a plain object is
   * true for `constructor`, `toString` and `__proto__`, so a property with one of those names was
   * skipped as already merged, and `merged["__proto__"] = ...` set the prototype instead.
   */
  const out = Object.create(null) as JsonObject;
  let shadow: Shadowed | undefined;
  const shadowed = (): Shadowed => (shadow ??= { keywords: new Map(), properties: new Map() });
  /*
   * The first contributor's `properties` is used as it is, and copied only when a second one adds
   * to it. Copying it every time made each `{"$ref": "#"}` cost the size of the root.
   */
  let ownsProperties = false;

  const merge = (source: JsonObject): void => {
    if (state.merged > MAX_MERGED_KEYS) return;
    const entries = Object.entries(source);
    state.merged += entries.length;
    for (const [key, value] of entries) {
      if (key === "$ref" || key === "allOf") continue;
      if (key === "properties") {
        const incoming = asObject(value);
        const held = asObject(out["properties"]);
        if (held === undefined) {
          out["properties"] = incoming ?? (Object.create(null) as JsonObject);
          continue;
        }
        if (incoming === undefined || incoming === held) continue;
        const names = Object.keys(incoming);
        if (names.length === 0) continue;
        // First contributor wins on a conflict, and keeps its position: the merged object reads
        // in the order a person wrote it, not inside-out from the inheritance chain.
        const merged = ownsProperties ? held : Object.assign(Object.create(null) as JsonObject, held);
        if (!ownsProperties) state.merged += Object.keys(held).length;
        state.merged += names.length;
        ownsProperties = true;
        for (const name of names) {
          const schema = incoming[name] as JsonValue;
          if (!Object.hasOwn(merged, name)) Object.defineProperty(merged, name, { value: schema, enumerable: true, writable: true, configurable: true });
          else if (merged[name] !== schema) remember(shadowed().properties, name, schema);
        }
        out["properties"] = merged;
      } else if (key === "required" && Array.isArray(value)) {
        const already = Array.isArray(out["required"]) ? (out["required"] as JsonValue[]) : [];
        state.merged += already.length + value.length;
        out["required"] = [...new Set([...already, ...value].filter((entry): entry is string => typeof entry === "string"))];
      } else if (!Object.hasOwn(out, key)) {
        out[key] = value;
      } else {
        const held = out[key] as JsonValue;
        if (held === value) continue;
        if (typeof held === "number" && typeof value === "number" && LOWER_BOUNDS.has(key)) out[key] = Math.max(held, value);
        else if (typeof held === "number" && typeof value === "number" && UPPER_BOUNDS.has(key)) out[key] = Math.min(held, value);
        else if (key === "enum" && Array.isArray(held) && Array.isArray(value)) {
          state.merged += held.length + value.length;
          out[key] = intersectEnum(held, value);
        } else if (key === "type") out[key] = intersectTypes(held, value);
        else if (!ANNOTATIONS.has(key)) remember(shadowed().keywords, key, value);
      }
    }
    // What the source could not hold itself comes along with it.
    const inherited = shadows.get(source);
    if (inherited) {
      for (const [key, values] of inherited.keywords) for (const value of values) remember(shadowed().keywords, key, value);
      for (const [name, values] of inherited.properties) for (const value of values) remember(shadowed().properties, name, value);
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

  if (shadow) shadows.set(out, shadow);
  if (depth === 0) state.nodes.set(object, out);
  return out;
}

/*
 * Read once per object. A walk visits a node once per route to it, and both of these used to be
 * rebuilt on every visit: a node with N properties reached N times cost N^2 before a single child
 * was looked at, and a walk that stops at its budget still paid for the whole list.
 */
const entryLists = new WeakMap<object, ReadonlyArray<readonly [string, JsonValue]>>();
const alternativeLists = new WeakMap<object, ReadonlyArray<{ label: string; schema: JsonValue }>>();

/** `Object.entries`, read once per object. */
export function entriesOf(object: JsonObject): ReadonlyArray<readonly [string, JsonValue]> {
  let entries = entryLists.get(object);
  if (!entries) {
    entries = Object.entries(object);
    entryLists.set(object, entries);
  }
  return entries;
}

/** The alternation branches at a node, labelled so a caller can key facts by them. */
export function alternatives(object: JsonObject): ReadonlyArray<{ label: string; schema: JsonValue }> {
  const known = alternativeLists.get(object);
  if (known) return known;
  const branches: Array<{ label: string; schema: JsonValue }> = [];
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const value = object[keyword];
    if (!Array.isArray(value)) continue;
    value.forEach((schema, index) => branches.push({ label: `${keyword}[${index}]`, schema }));
  }
  for (const keyword of ["then", "else", "not"] as const) {
    if (object[keyword] !== undefined) branches.push({ label: keyword, schema: object[keyword] as JsonValue });
  }
  alternativeLists.set(object, branches);
  return branches;
}
