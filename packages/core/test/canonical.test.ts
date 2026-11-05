/** RFC 8785 canonical form and the digests built on it. */
import { describe, expect, it } from "vitest";
import { MAX_DEPTH, canonicalize, digest, exceedsMaxDepth, stableKey, toJson } from "../src/lock/canonical";
import type { JsonValue } from "../src/lock/types";

describe("canonicalize", () => {
  it("sorts object keys so that member order cannot change a digest", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 }));
  });

  it("preserves array order, because array order can be significant", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ outer: { z: [{ b: 1, a: 2 }] } })).toBe('{"outer":{"z":[{"a":2,"b":1}]}}');
  });

  it("emits -0 as 0, per the RFC", () => {
    expect(canonicalize(-0)).toBe("0");
  });

  it("refuses non-finite numbers rather than inventing a serialization", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("refuses undefined rather than producing a confusing failure later", () => {
    expect(() => canonicalize(undefined as never)).toThrow(/toJson/);
  });

  it("produces a prefixed, fixed-length digest", () => {
    expect(digest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("toJson", () => {
  it("drops undefined members so an absent field and an unset one hash alike", () => {
    expect(toJson({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(digest(toJson({ a: 1, b: undefined }))).toBe(digest({ a: 1 }));
  });

  it("leaves null alone, which is a value rather than an absence", () => {
    expect(toJson({ a: null })).toEqual({ a: null });
    expect(digest(toJson({ a: null }))).not.toBe(digest({}));
  });
});

describe("stableKey", () => {
  it("compares values that still carry undefined members", () => {
    expect(stableKey({ a: 1, b: undefined })).toBe(stableKey({ a: 1 }));
  });
});

/*
 * Both walkers recurse, and both are handed JSON from somewhere we do not control: a third-party
 * MCP server answering the collector, or a reading posted to the control plane. V8 parses deeply
 * nested JSON iteratively, so a body that nests further than the call stack arrives intact and
 * the overflow lands here. A bound makes an oversized surface a fact about the input rather than
 * a stack trace about us.
 */
describe("a surface too deep to hash", () => {
  const nest = (depth: number) => JSON.parse("[".repeat(depth) + "]".repeat(depth)) as JsonValue;

  it("refuses rather than exhausting the stack", () => {
    // 60_000 is about 117 KB of request body, against a 16 MB ingest allowance.
    expect(() => canonicalize(nest(60_000))).toThrow(/nested deeper than/);
    expect(() => toJson(nest(60_000))).toThrow(/nested deeper than/);
  });

  it("names the input, not the implementation", () => {
    // The whole point of the bound: "Maximum call stack size exceeded" tells the caller nothing
    // they can act on.
    expect(() => toJson(nest(60_000))).not.toThrow(/call stack/);
  });

  it("still hashes anything a real surface could be", () => {
    // A tool's input schema is JSON Schema; the elaborate ones nest tens of levels, not hundreds.
    expect(() => canonicalize(nest(MAX_DEPTH - 1))).not.toThrow();
    expect(digest(nest(50))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("answers the same question without recursing, for use at the edge", () => {
    // A guard that walks the value recursively exhausts the stack on exactly the input it exists
    // to catch, so this one must not.
    expect(exceedsMaxDepth(nest(60_000))).toBe(true);
    expect(exceedsMaxDepth(nest(50))).toBe(false);
    expect(exceedsMaxDepth({ tools: [{ name: "read", schema: { type: "object" } }] })).toBe(false);
  });
})
;
