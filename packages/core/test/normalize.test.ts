/** Resolving annotations, schemas and the x-mcp-header surface. */
import { describe, expect, it } from "vitest";
import { extractHeaderParams, isEscalation, normalizeSchema, resolveBehavior, sanitizeUrl, stripIgnoredMeta } from "../src/lock/normalize";

describe("resolveBehavior", () => {
  it("applies the spec's defaults, which are not neutral", () => {
    // Absent annotations mean "may modify, may destroy, may reach the open world".
    expect(resolveBehavior(undefined)).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true });
  });

  it("treats a read-only tool as non-destructive and idempotent whatever it claims", () => {
    // Both hints are defined to be meaningful only when readOnlyHint is false.
    expect(resolveBehavior({ readOnlyHint: true, destructiveHint: true, idempotentHint: false })).toEqual({
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    });
  });

  it("honours explicit hints when the tool is not read-only", () => {
    expect(resolveBehavior({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })).toEqual({
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
  });
});

describe("isEscalation", () => {
  const readOnly = resolveBehavior({ readOnlyHint: true, openWorldHint: false });
  const unrestricted = resolveBehavior(undefined);

  it("treats losing read-only as an escalation", () => {
    expect(isEscalation(readOnly, unrestricted)).toBe(true);
  });

  it("does not treat gaining read-only as one", () => {
    expect(isEscalation(unrestricted, readOnly)).toBe(false);
  });
});

describe("normalizeSchema", () => {
  it("sorts `required`, whose order means nothing", () => {
    expect(normalizeSchema({ type: "object", required: ["b", "a"] })).toEqual({ type: "object", required: ["a", "b"] });
  });

  it("leaves other arrays alone, whose order can mean everything", () => {
    expect(normalizeSchema({ prefixItems: [{ type: "string" }, { type: "number" }] })).toEqual({
      prefixItems: [{ type: "string" }, { type: "number" }],
    });
    expect(normalizeSchema({ enum: ["b", "a"] })).toEqual({ enum: ["b", "a"] });
  });

  it("recurses into nested schemas", () => {
    expect(normalizeSchema({ properties: { nested: { required: ["z", "a"] } } })).toEqual({ properties: { nested: { required: ["a", "z"] } } });
  });
});

describe("extractHeaderParams", () => {
  it("finds a mirrored parameter and reports where it goes", () => {
    expect(extractHeaderParams({ type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } })).toEqual(["region -> Region"]);
  });

  it("walks nested properties and sorts the result", () => {
    const schema = {
      type: "object",
      properties: {
        z: { type: "string", "x-mcp-header": "Zed" },
        outer: { type: "object", properties: { inner: { type: "string", "x-mcp-header": "Inner" } } },
      },
    };
    expect(extractHeaderParams(schema)).toEqual(["outer.inner -> Inner", "z -> Zed"]);
  });

  it("returns nothing for an ordinary schema", () => {
    expect(extractHeaderParams({ type: "object", properties: { a: { type: "string" } } })).toEqual([]);
  });
});

describe("stripIgnoredMeta", () => {
  it("removes ignored prefixes and keeps the rest", () => {
    expect(stripIgnoredMeta({ "com.example/build": 1, "io.modelcontextprotocol/x": 2 }, ["com.example/"])).toEqual({ "io.modelcontextprotocol/x": 2 });
  });

  it("returns undefined when nothing is left to pin", () => {
    expect(stripIgnoredMeta({ "com.example/build": 1 }, ["com.example/"])).toBeUndefined();
    expect(stripIgnoredMeta(undefined, [])).toBeUndefined();
  });
});

describe("sanitizeUrl", () => {
  it("drops the query string and fragment", () => {
    expect(sanitizeUrl("https://x.example/mcp?token=abc#frag")).toBe("https://x.example/mcp");
  });

  it("leaves an unparseable value visible rather than silently rewriting it", () => {
    expect(sanitizeUrl("not a url")).toBe("not a url");
  });
});
