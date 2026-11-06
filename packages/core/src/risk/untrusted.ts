/**
 * Coercion for values that arrived from somewhere else.
 *
 * Everything in `risk/` reads a declaration a server sent, or a reading a collector posted. The
 * types say `{ name?: string }[]`, and a type is a claim about a value this code never checked:
 * `tools` is whatever was in the JSON, so it can be absent, a string, or an array with a `null`
 * in it. `tool.name` on that `null` throws a TypeError.
 *
 * In the CLI that aborts one audit, which is survivable. In the control plane the same call sits
 * inside ingest, where one malformed element in one tool of one server would fail the whole
 * request -- every other server in that reading included. A classifier is a security control, and
 * a security control that can be switched off by sending it a `null` is one an attacker turns off
 * rather than evades.
 *
 * So the guard belongs here, at the point the value is first believed, rather than at each of the
 * places that go on to read it.
 */

/** The members of `value` that are objects, or an empty list if it is not a list at all. */
export function objectsIn(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((member): member is Record<string, unknown> => typeof member === "object" && member !== null);
}

/** `value` if it is a non-null object, otherwise an empty one, so a property read is always safe. */
export function objectOr(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** `value` if it is a string, otherwise undefined: a `name` that is a number is not a name. */
export function stringOr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
