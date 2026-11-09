/**
 * Labelling a JSON Schema change as a widening or a narrowing.
 *
 * Deciding whether one schema accepts a superset of another is not tractable in general, so this
 * is a heuristic over the keywords that carry almost all real changes. It is used only to rank
 * and describe a finding: every schema change fails `check` regardless of the label. A heuristic
 * is fine for sorting a list; it would not be fine for deciding whether CI goes green.
 */
import { canonicalize, stableKey } from "../lock/canonical";
import { alternatives, asObject, effectiveSchema, MAX_FACTS, MAX_VISIT_DEPTH } from "../lock/jsonschema";
import type { JsonObject, JsonValue } from "../lock/types";

export type SchemaVerdict = "widened" | "narrowed" | "changed" | "same";

interface Facts {
  required: boolean;
  additionalProperties?: boolean;
  enumMembers?: string[];
  types?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

function numberAt(node: JsonObject, key: string): number | undefined {
  const value = node[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Flattens a schema into per-path facts.
 *
 * `$ref` and `allOf` are resolved before a node is read, so a schema that keeps its properties
 * in `$defs` is compared on the same terms as one that inlines them. Alternation branches get
 * their own path segment (`arg|anyOf[1]`), which makes an added branch show up as new facts --
 * a widening -- and a removed one as a narrowing, without special-casing either.
 */
function collectFacts(schema: JsonValue): Map<string, Facts> {
  const facts = new Map<string, Facts>();

  const visit = (node: JsonValue, path: string, required: boolean, depth: number): void => {
    if (depth > MAX_VISIT_DEPTH || facts.size >= MAX_FACTS) return;
    const object = effectiveSchema(node, schema);
    if (!object) return;

    const typeValue = object["type"];
    const types =
      typeof typeValue === "string"
        ? [typeValue]
        : Array.isArray(typeValue)
          ? typeValue.filter((entry): entry is string => typeof entry === "string").sort()
          : undefined;
    const enumValue = object["enum"];

    facts.set(path, {
      required,
      additionalProperties: typeof object["additionalProperties"] === "boolean" ? object["additionalProperties"] : undefined,
      enumMembers: Array.isArray(enumValue) ? enumValue.map((entry) => canonicalize(entry)).sort() : undefined,
      types,
      minimum: numberAt(object, "minimum"),
      maximum: numberAt(object, "maximum"),
      minLength: numberAt(object, "minLength"),
      maxLength: numberAt(object, "maxLength"),
    });

    const properties = asObject(object["properties"]);
    if (properties) {
      const requiredList = Array.isArray(object["required"])
        ? (object["required"] as JsonValue[]).filter((entry): entry is string => typeof entry === "string")
        : [];
      const requiredSet = new Set(requiredList);
      for (const [name, child] of Object.entries(properties)) {
        visit(child, path === "" ? name : `${path}.${name}`, requiredSet.has(name), depth + 1);
      }
    }

    const items = object["items"];
    if (items !== undefined) visit(items, `${path}[]`, false, depth + 1);

    const prefixItems = object["prefixItems"];
    if (Array.isArray(prefixItems)) prefixItems.forEach((entry, index) => visit(entry, `${path}[${index}]`, false, depth + 1));

    for (const branch of alternatives(object)) visit(branch.schema, `${path}|${branch.label}`, false, depth + 1);
  };

  visit(schema, "", true, 0);
  return facts;
}

/**
 * Whether every member of `previous` is in `next`. A set, not `includes` in a loop: that was
 * quadratic, and a server's own schema decides the length, so one enum of a few hundred thousand
 * members held whatever compared it -- the CLI, or a control plane serving every tenant from one
 * thread -- for minutes.
 */
function isSuperset(next: readonly string[], previous: readonly string[]): boolean {
  const members = new Set(next);
  return previous.every((entry) => members.has(entry));
}

export function classifySchemaChange(before: JsonValue, after: JsonValue): SchemaVerdict {
  if (stableKey(before) === stableKey(after)) return "same";

  const previous = collectFacts(before);
  const next = collectFacts(after);

  let widened = false;
  let narrowed = false;

  for (const path of new Set([...previous.keys(), ...next.keys()])) {
    const a = previous.get(path);
    const b = next.get(path);

    // A new property is a widening even when it is optional: it enlarges what the agent may be
    // induced to send.
    if (!a && b) { widened = true; continue; }
    if (a && !b) { narrowed = true; continue; }
    if (!a || !b) continue;

    if (a.required && !b.required) widened = true;
    if (!a.required && b.required) narrowed = true;

    const beforeAdditional = a.additionalProperties ?? true;
    const afterAdditional = b.additionalProperties ?? true;
    if (!beforeAdditional && afterAdditional) widened = true;
    if (beforeAdditional && !afterAdditional) narrowed = true;

    if (a.enumMembers && b.enumMembers) {
      if (isSuperset(b.enumMembers, a.enumMembers) && b.enumMembers.length > a.enumMembers.length) widened = true;
      else if (isSuperset(a.enumMembers, b.enumMembers) && a.enumMembers.length > b.enumMembers.length) narrowed = true;
      else if (canonicalize(a.enumMembers) !== canonicalize(b.enumMembers)) { widened = true; narrowed = true; }
    } else if (a.enumMembers && !b.enumMembers) widened = true;
    else if (!a.enumMembers && b.enumMembers) narrowed = true;

    if (a.types && b.types) {
      if (isSuperset(b.types, a.types) && b.types.length > a.types.length) widened = true;
      else if (isSuperset(a.types, b.types) && a.types.length > b.types.length) narrowed = true;
      else if (canonicalize(a.types) !== canonicalize(b.types)) { widened = true; narrowed = true; }
    } else if (a.types && !b.types) widened = true;
    else if (!a.types && b.types) narrowed = true;

    // A bound that disappears loosens; one that appears tightens.
    const lowerBounds = [["minimum", a.minimum, b.minimum] as const, ["minLength", a.minLength, b.minLength] as const];
    for (const [, before_, after_] of lowerBounds) {
      if (before_ !== undefined && after_ === undefined) widened = true;
      else if (before_ === undefined && after_ !== undefined) narrowed = true;
      else if (before_ !== undefined && after_ !== undefined) {
        if (after_ < before_) widened = true;
        if (after_ > before_) narrowed = true;
      }
    }
    const upperBounds = [["maximum", a.maximum, b.maximum] as const, ["maxLength", a.maxLength, b.maxLength] as const];
    for (const [, before_, after_] of upperBounds) {
      if (before_ !== undefined && after_ === undefined) widened = true;
      else if (before_ === undefined && after_ !== undefined) narrowed = true;
      else if (before_ !== undefined && after_ !== undefined) {
        if (after_ > before_) widened = true;
        if (after_ < before_) narrowed = true;
      }
    }
  }

  if (widened && !narrowed) return "widened";
  if (narrowed && !widened) return "narrowed";
  // Both directions at once, or a change in a keyword this heuristic does not model.
  return "changed";
}
