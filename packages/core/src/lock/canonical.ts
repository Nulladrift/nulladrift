/**
 * RFC 8785 (JSON Canonicalization Scheme) and the digests built on it.
 *
 * JCS rather than a scheme of our own: the hard parts -- key ordering, string escaping, number
 * formatting -- are already specified, so a second implementation can reproduce our digests from
 * the RFC alone rather than from our source.
 *
 * This is separate from how the lockfile is laid out on disk (see io.ts). Hashing sorts every
 * key; the file keeps a declared, readable order. One is for machines, the other for reviewers.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "./types";

/**
 * How deep a surface is allowed to be before we refuse to hash it.
 *
 * Both functions below walk their argument with ordinary recursion, and both are handed JSON
 * that came from somewhere we do not control: a third-party MCP server answering the collector,
 * or a reading posted to the control plane. V8 parses deeply nested JSON iteratively, so a body
 * that nests further than the call stack reaches arrives intact and the overflow happens here.
 * At 16 MB, the ingest allowance, that costs an attacker about a hundred kilobytes.
 *
 * Neither caller breaks when it happens -- the collector reports the server unreachable and the
 * control plane answers 500 -- but both report a stack overflow, which describes our
 * implementation rather than their input. A bound makes it a fact about the input, and a limit
 * the caller can act on.
 *
 * A hundred is far above any real surface. A tool's input schema is JSON Schema, and the
 * elaborate ones nest tens of levels, not hundreds.
 */
export const MAX_DEPTH = 100;

const tooDeep = () =>
  new TypeError(`cannot canonicalize JSON nested deeper than ${MAX_DEPTH} levels; this is not a surface we can hash`);

/**
 * JCS sorts object members by the UTF-16 code units of their keys, which is exactly what
 * `Array.prototype.sort` does by default. Numbers go through `JSON.stringify`, whose output
 * for finite numbers is the ES6 Number-to-String the RFC requires.
 */
export function canonicalize(value: JsonValue, depth = 0): string {
  if (depth > MAX_DEPTH) throw tooDeep();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    // JSON has no undefined. Reaching here means a caller skipped `toJson`, which would
    // otherwise surface much later as a digest that silently disagrees with itself.
    throw new TypeError("cannot canonicalize undefined; pass the value through toJson first");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`cannot canonicalize non-finite number: ${value}`);
    // `-0` serializes as `0`, matching the RFC.
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) {
    // `map(canonicalize)` would hand the callback the array index as the second argument, which
    // is now the depth. Passing it explicitly is the whole reason this is not point-free.
    return `[${value.map((member) => canonicalize(member, depth + 1)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue, depth + 1)}`);
  return `{${members.join(",")}}`;
}

/**
 * Whether a value is too deep to hash, answered without recursing.
 *
 * Deliberately iterative: a guard against stack exhaustion that walks the value recursively
 * exhausts the stack on exactly the input it exists to catch. An explicit stack moves the
 * problem to the heap, where the body-size limit already bounds it.
 *
 * This is for request validation, so that a reading too deep to hash is refused at the edge
 * with a message naming the field, rather than hashed and refused as an internal error.
 */
export function exceedsMaxDepth(value: unknown): boolean {
  const pending: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    if (next.depth > MAX_DEPTH) return true;
    if (next.node === null || typeof next.node !== "object") continue;
    const members = Array.isArray(next.node) ? next.node : Object.values(next.node);
    for (const member of members) pending.push({ node: member, depth: next.depth + 1 });
  }
  return false;
}

export function digest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

/**
 * Drops `undefined` members so that an absent optional field and a field explicitly set to
 * `undefined` hash identically. Without this, building the same tool through two code paths could
 * produce two digests for one capability.
 */
export function toJson(value: unknown, depth = 0): JsonValue {
  // Bounded for the same reason `canonicalize` is, and it matters more here: `digest` and
  // `stableKey` both run this first, so this is where an oversized surface lands.
  if (depth > MAX_DEPTH) throw tooDeep();
  if (value === null) return null;
  // Not `map(toJson)`: that would pass the array index as the depth.
  if (Array.isArray(value)) return value.map((member) => toJson(member, depth + 1));
  if (typeof value === "object") {
    /*
     * No prototype. `out[key] = ...` on a plain `{}` sends a key named `__proto__` to the
     * prototype setter instead of making it a property, so a schema property called `__proto__`
     * vanished from the lock and the digest while real clients passed it to the model: a server
     * could add or rewrite it and `check` reported a match. JSON.parse keeps such a key as an own
     * property; this has to as well.
     */
    const out = Object.create(null) as Record<string, JsonValue>;
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (member === undefined) continue;
      out[key] = toJson(member, depth + 1);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  // Functions, symbols and bigints cannot reach here from parsed JSON; treat as absent.
  return null;
}

/**
 * Canonical form of a value that may carry `undefined` members -- an in-memory lock entry, say,
 * where optional fields are present but unset. Comparing two of those directly is the common
 * case in the diff engine, and it must agree with the digest of the same value.
 */
export function stableKey(value: unknown): string {
  return canonicalize(toJson(value));
}
