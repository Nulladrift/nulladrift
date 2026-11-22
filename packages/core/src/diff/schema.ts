/**
 * Labelling a JSON Schema change as a widening or a narrowing.
 *
 * Deciding whether one schema accepts a superset of another is not tractable in general, so this
 * is a heuristic over the keywords that carry almost all real changes. It is used only to rank
 * and describe a finding: every schema change fails `check` regardless of the label. A heuristic
 * is fine for sorting a list; it would not be fine for deciding whether CI goes green.
 */
import { canonicalize, stableKey } from "../lock/canonical";
import { asObject, beginWalk, effectiveSchema, entriesOf, MAX_FACTS, MAX_VISIT_DEPTH, shadowedIn } from "../lock/jsonschema";
import type { JsonObject, JsonValue } from "../lock/types";

export type SchemaVerdict = "widened" | "narrowed" | "changed" | "same";

/** What one node accepts, read from its effective schema. Shared by every route that reaches the node. */
interface Constraints {
  /** `additionalProperties`: `false`, a schema, or anything -- in order of how much each lets through. */
  additional: 0 | 1 | 2;
  enumMembers?: ReadonlySet<string>;
  types?: ReadonlySet<string>;
  lower: ReadonlyMap<string, number>;
  upper: ReadonlyMap<string, number>;
  /** Keywords read only as present, absent or different, with every value of each that applies. */
  opaque: ReadonlyMap<string, ReadonlySet<string>>;
  /** Keywords holding a subschema the input must also match: `items`, `anyOf`, `oneOf`, `then`, `else`. */
  slots: ReadonlySet<string>;
  requiredNames: ReadonlySet<string>;
}

interface Fact {
  /** The route of the fact this one hangs from; undefined at the root. */
  parent?: number;
  /** The keyword it was reached through. */
  via: string;
  required: boolean;
  node: Constraints;
}

const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties", "minContains"];
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties", "maxContains"];

/*
 * Keywords the heuristic does not read inside, but whose direction is not in doubt: each one only
 * ever excludes input. One that disappears lets more through and one that appears lets less, and
 * one that changes could go either way. They had no slot at all, so taking a path guard off a file
 * tool -- `pattern: "^/srv/data/[a-z]+$"` -- was a bare `changed`, and beside any narrowing
 * elsewhere it read as a narrowing.
 *
 * `not` is among them rather than walked as a branch. Walked, a `not` added read as new facts, a
 * widening, when it excludes input.
 */
const OPAQUE = [
  "pattern", "format", "multipleOf", "uniqueItems", "not", "if", "contains", "propertyNames", "dependentRequired",
  "dependentSchemas", "dependencies", "unevaluatedProperties", "unevaluatedItems", "additionalItems",
];
/** Opaque keywords whose `true` or `{}` constrains nothing, and so is the same as their absence. */
const OPEN_WHEN_EMPTY = new Set(["unevaluatedProperties", "unevaluatedItems", "additionalItems", "propertyNames"]);
const SLOT_KEYWORDS = ["items", "anyOf", "oneOf", "then", "else"];
const CONSIDERED = new Set([...LOWER_BOUNDS, ...UPPER_BOUNDS, ...OPAQUE, ...SLOT_KEYWORDS]);

/*
 * Reached through one of these, a node is one more thing the input may hold, so its arrival is a
 * widening and its departure a narrowing. A new property is a widening even when it is optional:
 * it enlarges what the agent may be induced to send.
 *
 * Reached through anything else -- `items`, a branch of `anyOf`, `then` -- a node is a constraint
 * the input must also meet, and whether that constraint came or went is read off the parent.
 */
const MEMBERS = new Set(["properties", "patternProperties", "prefixItems"]);

function isOpen(value: JsonValue | undefined): boolean {
  if (value === true) return true;
  const object = asObject(value);
  return object !== undefined && Object.keys(object).length === 0;
}

function isVacuous(keyword: string, value: JsonValue): boolean {
  if (value === false) return keyword === "uniqueItems" || keyword === "exclusiveMinimum" || keyword === "exclusiveMaximum";
  return OPEN_WHEN_EMPTY.has(keyword) && isOpen(value);
}

/** The JSON types of some values: what an `enum` or a `const` says about `type`. */
function typesOf(values: readonly JsonValue[]): Set<string> {
  const types = new Set<string>();
  for (const value of values) {
    if (value === null) types.add("null");
    else if (Array.isArray(value)) types.add("array");
    else if (typeof value === "number") types.add(Number.isInteger(value) ? "integer" : "number");
    else types.add(typeof value);
  }
  return types;
}

/** `type`, `enum` and `const` at one node, before anything is inferred from its branches. */
function ownValues(object: JsonObject): { types?: Set<string>; members?: Set<string> } {
  let values = Array.isArray(object["enum"]) ? (object["enum"] as JsonValue[]) : undefined;
  // A `const` is an enum of one, and every `const` that applies must hold.
  const consts = [...(Object.hasOwn(object, "const") ? [object["const"] as JsonValue] : []), ...(shadowedIn(object)?.keywords.get("const") ?? [])];
  for (const value of consts) {
    const key = canonicalize(value);
    values = values === undefined ? [value] : values.filter((member) => canonicalize(member) === key);
  }
  const typeValue = object["type"];
  let types =
    typeof typeValue === "string"
      ? new Set([typeValue])
      : Array.isArray(typeValue)
        ? new Set(typeValue.filter((entry): entry is string => typeof entry === "string"))
        : undefined;
  if (types === undefined && values !== undefined) types = typesOf(values);
  return { types, members: values === undefined ? undefined : new Set(values.map((member) => canonicalize(member))) };
}

/*
 * What an alternation allows, for a node that says nothing itself: the union over its branches.
 * Without it, `anyOf: [{const: "users"}, {const: "orders"}]` replaced by `type: "string"` gained a
 * type and lost nothing anyone could see. A branch that is only `null` is how Pydantic writes
 * `Optional[...]` -- the argument may be left out -- and is not counted as a value the tool takes,
 * so `Optional[Literal["read"]]` reads as "read", and its replacement by any string as a widening.
 */
function unionOfBranches(branches: readonly JsonValue[], root: JsonValue): { types?: Set<string>; members?: Set<string> } {
  let types: Set<string> | undefined = new Set();
  let members: Set<string> | undefined = new Set();
  let counted = 0;
  for (const branch of branches) {
    if (branch === false) continue;
    const object = effectiveSchema(branch, root);
    // `true`, or not a schema at all: this branch allows anything.
    if (object === undefined) return {};
    const own = ownValues(object);
    const onlyNull = own.members === undefined ? own.types?.size === 1 && own.types.has("null") : own.members.size === 1 && own.members.has("null");
    if (onlyNull) continue;
    counted += 1;
    if (types) {
      if (own.types) for (const type of own.types) types.add(type);
      else types = undefined;
    }
    if (members) {
      if (own.members) for (const member of own.members) members.add(member);
      else members = undefined;
    }
  }
  return counted === 0 ? {} : { types, members };
}

const constraintCache = new WeakMap<object, WeakMap<JsonObject, Constraints>>();

/*
 * Worked out once per node and schema. A node reached by a thousand routes is the same node, and
 * reading a long enum or a long `required` again for each of them is how a schema of a few
 * kilobytes costs minutes.
 */
function constraintsOf(object: JsonObject, root: JsonValue): Constraints {
  const key = root !== null && typeof root === "object" ? root : constraintCache;
  let cache = constraintCache.get(key);
  if (!cache) {
    cache = new WeakMap();
    constraintCache.set(key, cache);
  }
  const known = cache.get(object);
  if (known) return known;

  let { types, members } = ownValues(object);
  if (types === undefined || members === undefined) {
    const anyOf = Array.isArray(object["anyOf"]) ? (object["anyOf"] as JsonValue[]) : undefined;
    const oneOf = Array.isArray(object["oneOf"]) ? (object["oneOf"] as JsonValue[]) : undefined;
    const branches = anyOf && !oneOf ? anyOf : oneOf && !anyOf ? oneOf : undefined;
    if (branches) {
      const union = unionOfBranches(branches, root);
      types ??= union.types;
      members ??= union.members;
    }
  }

  const lower = new Map<string, number>();
  const upper = new Map<string, number>();
  const opaque = new Map<string, Set<string>>();
  const constrain = (keyword: string, value: JsonValue): void => {
    if (isVacuous(keyword, value)) return;
    let values = opaque.get(keyword);
    if (!values) {
      values = new Set();
      opaque.set(keyword, values);
    }
    values.add(canonicalize(value));
  };
  for (const [keywords, bounds] of [[LOWER_BOUNDS, lower], [UPPER_BOUNDS, upper]] as const) {
    for (const keyword of keywords) {
      const value = object[keyword];
      if (typeof value === "number") bounds.set(keyword, value);
      else if (value !== undefined) constrain(keyword, value); // draft 4's boolean `exclusiveMaximum`
    }
  }
  for (const keyword of OPAQUE) if (object[keyword] !== undefined) constrain(keyword, object[keyword] as JsonValue);

  /*
   * What a second `allOf` branch said that the merged node could not hold: a second pattern, a
   * second schema for a property. Each is one more constraint, so it is counted like one.
   */
  const shadow = shadowedIn(object);
  if (shadow) {
    for (const [keyword, values] of shadow.keywords) if (CONSIDERED.has(keyword)) for (const value of values) constrain(keyword, value);
    for (const [name, values] of shadow.properties) for (const value of values) constrain(`\u0000properties\u0000${name}`, value);
  }

  const slots = new Set<string>();
  const items = object["items"];
  if (items !== undefined && !Array.isArray(items) && !isOpen(items)) slots.add("items");
  for (const keyword of ["anyOf", "oneOf"]) if (Array.isArray(object[keyword])) slots.add(keyword);
  for (const keyword of ["then", "else"]) if (object[keyword] !== undefined && !isOpen(object[keyword])) slots.add(keyword);

  const additionalValue = object["additionalProperties"];
  const required = Array.isArray(object["required"]) ? (object["required"] as JsonValue[]) : [];
  const constraints: Constraints = {
    additional: additionalValue === false ? 0 : asObject(additionalValue) !== undefined && !isOpen(additionalValue) ? 1 : 2,
    enumMembers: members,
    types,
    lower,
    upper,
    opaque,
    slots,
    requiredNames: new Set(required.filter((entry): entry is string => typeof entry === "string")),
  };
  cache.set(object, constraints);
  return constraints;
}

/*
 * Routes through a schema, numbered, and shared by both sides of a comparison so the same route
 * gets the same number on each.
 *
 * Facts were keyed by property names joined with ".", "[]" and "|anyOf[0]", and names may contain
 * any of those. So a property named "opts.mode" was the same fact as `mode` inside `opts`: a new
 * argument of that name overwrote the facts of the nested one it mimicked, and a dropped enum
 * there vanished. Worse, every route of the same spelling collapsed into one fact, and the ceiling
 * counted facts: properties "a", "a.a", "a.a.a" and "a.a.a.a", each the whole schema again, kept
 * the facts in single figures while the routes to them grew as m^12 -- 112 bytes held `check` for
 * 82 seconds. A number per (parent, keyword, name) cannot be spelled by a name.
 */
class Routes {
  private readonly names = new Map<string, number>();
  private readonly ids = new Map<string, number>();

  child(parent: number, keyword: string, name: string): number {
    let nameId = this.names.get(name);
    if (nameId === undefined) {
      nameId = this.names.size;
      this.names.set(name, nameId);
    }
    const key = `${parent} ${keyword} ${nameId}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(key, id);
    }
    return id;
  }
}

/**
 * Flattens a schema into per-route facts.
 *
 * `$ref` and `allOf` are resolved before a node is read, so a schema that keeps its properties
 * in `$defs` is compared on the same terms as one that inlines them. Alternation branches get a
 * route of their own, so a branch added to an alternation both sides have shows up as new facts
 * -- a widening -- and a removed one as a narrowing. The alternation as a whole is a constraint,
 * read on its parent (see `slots`).
 *
 * The ceiling counts visits, not facts: a visit is the work, and the facts are only what it
 * leaves behind.
 */
function collectFacts(schema: JsonValue, routes: Routes): Map<number, Fact> {
  const facts = new Map<number, Fact>();
  let budget = MAX_FACTS;

  const visit = (node: JsonValue, id: number, parent: number | undefined, via: string, required: boolean, depth: number): void => {
    if (depth > MAX_VISIT_DEPTH || budget <= 0) return;
    budget -= 1;
    const object = effectiveSchema(node, schema);
    if (!object) return;
    const constraints = constraintsOf(object, schema);
    facts.set(id, { parent, via, required, node: constraints });
    // Its children would be past the depth ceiling, and naming a route to each one is the cost.
    if (depth >= MAX_VISIT_DEPTH) return;

    // False once the budget is spent, so a node with a million children stops at the first.
    const into = (keyword: string, name: string, child: JsonValue | undefined, isRequired = false): boolean => {
      if (budget <= 0) return false;
      if (child !== undefined) visit(child, routes.child(id, keyword, name), id, keyword, isRequired, depth + 1);
      return true;
    };

    const properties = asObject(object["properties"]);
    if (properties) {
      for (const [name, child] of entriesOf(properties)) if (!into("properties", name, child, constraints.requiredNames.has(name))) return;
    }
    const patternProperties = asObject(object["patternProperties"]);
    if (patternProperties) {
      for (const [pattern, child] of entriesOf(patternProperties)) if (!into("patternProperties", pattern, child)) return;
    }
    // `items` as a list is draft 4's `prefixItems`.
    for (const keyword of ["prefixItems", "items"]) {
      const tuple = object[keyword];
      if (!Array.isArray(tuple)) continue;
      for (let index = 0; index < tuple.length; index += 1) if (!into("prefixItems", String(index), tuple[index])) return;
    }
    if (constraints.slots.has("items") && !into("items", "", object["items"])) return;
    if (constraints.additional === 1 && !into("additionalProperties", "", object["additionalProperties"])) return;
    for (const keyword of ["anyOf", "oneOf"]) {
      const branches = object[keyword];
      if (!Array.isArray(branches)) continue;
      for (let index = 0; index < branches.length; index += 1) if (!into(keyword, String(index), branches[index])) return;
    }
    for (const keyword of ["then", "else"]) if (constraints.slots.has(keyword) && !into(keyword, "", object[keyword])) return;
  };

  beginWalk(schema);
  visit(schema, 0, undefined, "", true, 0);
  return facts;
}

/**
 * Whether every member of `previous` is in `next`. A set, not `includes` in a loop: that was
 * quadratic, and a server's own schema decides the length, so one enum of a few hundred thousand
 * members held whatever compared it -- the CLI, or a control plane serving every tenant from one
 * thread -- for minutes.
 */
function isSuperset(next: ReadonlySet<string>, previous: ReadonlySet<string>): boolean {
  if (previous.size > next.size) return false;
  for (const entry of previous) if (!next.has(entry)) return false;
  return true;
}

interface Direction {
  widened: boolean;
  narrowed: boolean;
}

/** `integer` is a `number`, so a type that became `number` was widened, not swapped. */
function covers(types: ReadonlySet<string>, type: string): boolean {
  return types.has(type) || (type === "integer" && types.has("number"));
}

function compareConstraints(a: Constraints, b: Constraints): Direction {
  let widened = false;
  let narrowed = false;

  if (b.additional > a.additional) widened = true;
  else if (b.additional < a.additional) narrowed = true;

  // Allowed values: one that appears widens, one that goes narrows, and no list at all allows anything.
  if (a.enumMembers && b.enumMembers) {
    if (!isSuperset(b.enumMembers, a.enumMembers)) narrowed = true;
    if (!isSuperset(a.enumMembers, b.enumMembers)) widened = true;
  } else if (a.enumMembers && !b.enumMembers) widened = true;
  else if (!a.enumMembers && b.enumMembers) narrowed = true;

  if (a.types && b.types) {
    for (const type of b.types) if (!covers(a.types, type)) widened = true;
    for (const type of a.types) if (!covers(b.types, type)) narrowed = true;
  } else if (a.types && !b.types) widened = true;
  else if (!a.types && b.types) narrowed = true;

  // A bound that disappears loosens; one that appears tightens.
  for (const [keyword, before] of a.lower) {
    const after = b.lower.get(keyword);
    if (after === undefined || after < before) widened = true;
    if (after !== undefined && after > before) narrowed = true;
  }
  for (const keyword of b.lower.keys()) if (!a.lower.has(keyword)) narrowed = true;
  for (const [keyword, before] of a.upper) {
    const after = b.upper.get(keyword);
    if (after === undefined || after > before) widened = true;
    if (after !== undefined && after < before) narrowed = true;
  }
  for (const keyword of b.upper.keys()) if (!a.upper.has(keyword)) narrowed = true;

  // A constraint that goes lets more through, and one that arrives lets less.
  for (const [keyword, before] of a.opaque) {
    const after = b.opaque.get(keyword);
    if (!after || !isSuperset(after, before)) widened = true;
    if (after && !isSuperset(before, after)) narrowed = true;
  }
  for (const keyword of b.opaque.keys()) if (!a.opaque.has(keyword)) narrowed = true;

  /*
   * An alternation, an `items` schema, a `then`: present before and gone after is a constraint
   * lifted. Its branches used to be compared as extra facts, so removing a whole `anyOf` read as
   * removing facts -- a narrowing -- and `run_query` going from two allowed tables to any string
   * was reported as `tool.input_schema.narrowed`, low. Found in a security review.
   */
  for (const keyword of a.slots) if (!b.slots.has(keyword)) widened = true;
  for (const keyword of b.slots) if (!a.slots.has(keyword)) narrowed = true;

  return { widened, narrowed };
}

export function classifySchemaChange(before: JsonValue, after: JsonValue): SchemaVerdict {
  if (stableKey(before) === stableKey(after)) return "same";

  const routes = new Routes();
  const previous = collectFacts(before, routes);
  const next = collectFacts(after, routes);

  let widened = false;
  let narrowed = false;
  // Nodes reached by many routes are compared once per pair, not once per route.
  const compared = new Map<Constraints, Map<Constraints, Direction>>();

  const oneSided = (fact: Fact, arrived: boolean): void => {
    const counterpart = fact.parent === undefined ? undefined : (arrived ? previous : next).get(fact.parent);
    if (counterpart === undefined) {
      // Beneath something that is itself on one side only, and has been counted. A property
      // declared there is still one more thing the agent may be asked for.
      if (arrived && MEMBERS.has(fact.via)) widened = true;
      return;
    }
    // A member, or a branch added to (or taken from) an alternation the other side also has.
    if (MEMBERS.has(fact.via) || counterpart.node.slots.has(fact.via)) {
      if (arrived) widened = true;
      else narrowed = true;
    }
    // Otherwise the keyword holding it came or went, and comparing the parent said which way.
  };

  for (const [id, a] of previous) {
    const b = next.get(id);
    if (!b) {
      oneSided(a, false);
    } else {
      if (a.required && !b.required) widened = true;
      if (!a.required && b.required) narrowed = true;
      if (a.node !== b.node) {
        let row = compared.get(a.node);
        if (!row) {
          row = new Map();
          compared.set(a.node, row);
        }
        let direction = row.get(b.node);
        if (!direction) {
          direction = compareConstraints(a.node, b.node);
          row.set(b.node, direction);
        }
        if (direction.widened) widened = true;
        if (direction.narrowed) narrowed = true;
      }
    }
    if (widened && narrowed) return "changed";
  }
  for (const [id, b] of next) if (!previous.has(id)) oneSided(b, true);

  if (widened && !narrowed) return "widened";
  if (narrowed && !widened) return "narrowed";
  // Both directions at once, or a change in a keyword this heuristic does not model.
  return "changed";
}
