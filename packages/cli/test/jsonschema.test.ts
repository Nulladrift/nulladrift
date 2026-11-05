/**
 * Seeing through `$ref` and `allOf`.
 *
 * Schema generators for Pydantic, Zod and most OpenAPI toolchains put properties behind `$defs`
 * by default, so a reader that only looked at literal nodes saw an empty object for a large
 * share of real tools. Both things that read a schema -- the widening heuristic and the
 * `x-mcp-header` scan -- failed quietly on exactly those.
 */
import { describe, expect, it } from "vitest";
import { diffLockfiles } from "../src/diff";
import { classifySchemaChange } from "../src/diff/schema";
import { effectiveSchema, resolvePointer } from "../src/lock/jsonschema";
import { extractHeaderParams } from "../src/lock/normalize";
import type { JsonValue } from "../src/lock/types";
import { lockOfTools, makeTool } from "./helpers";

const refSchema = (extraProps: Record<string, unknown> = {}, required: string[] = ["path"]) => ({
  type: "object" as const,
  $defs: {
    Args: {
      type: "object",
      properties: { path: { type: "string" }, ...extraProps },
      required,
    },
  },
  $ref: "#/$defs/Args",
});

describe("resolvePointer", () => {
  it("follows a local pointer and decodes escapes", () => {
    const root: JsonValue = { $defs: { "a/b": { type: "string" }, "c~d": { type: "number" } } };
    expect(resolvePointer(root, "#/$defs/a~1b")).toEqual({ type: "string" });
    expect(resolvePointer(root, "#/$defs/c~0d")).toEqual({ type: "number" });
  });

  it("never follows a remote reference", () => {
    // An audit that fetches a URL named by the thing it is auditing is not an audit.
    expect(resolvePointer({}, "https://evil.example/schema.json")).toBeUndefined();
    expect(resolvePointer({}, "other.json#/$defs/X")).toBeUndefined();
  });
});

describe("effectiveSchema", () => {
  it("folds allOf branches together, unioning properties and required", () => {
    const schema: JsonValue = {
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { properties: { b: { type: "number" } }, required: ["b"] },
      ],
    };
    const effective = effectiveSchema(schema, schema);
    expect(Object.keys(effective?.["properties"] as object)).toEqual(["a", "b"]);
    expect(effective?.["required"]).toEqual(["a", "b"]);
  });

  it("lets a node's own keywords win over what it inherits", () => {
    const schema: JsonValue = { $defs: { Base: { type: "object", additionalProperties: true } }, $ref: "#/$defs/Base", additionalProperties: false };
    expect(effectiveSchema(schema, schema)?.["additionalProperties"]).toBe(false);
  });

  it("terminates on a recursive reference", () => {
    const schema: JsonValue = { $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } }, $ref: "#/$defs/Node" };
    expect(() => effectiveSchema(schema, schema)).not.toThrow();
    expect(extractHeaderParams(schema)).toEqual([]);
  });
});

describe("widening behind indirection", () => {
  it("sees a new property added inside $defs", () => {
    // Previously this fell through to a bare `.changed`, hiding that the tool now accepts more.
    expect(classifySchemaChange(refSchema(), refSchema({ follow_symlinks: { type: "boolean" } }))).toBe("widened");
  });

  it("sees a dropped `required` inside $defs", () => {
    expect(classifySchemaChange(refSchema({}, ["path"]), refSchema({}, []))).toBe("widened");
  });

  it("sees a property added through an allOf branch", () => {
    const before: JsonValue = { type: "object", allOf: [{ properties: { a: { type: "string" } } }] };
    const after: JsonValue = { type: "object", allOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "string" } } }] };
    expect(classifySchemaChange(before, after)).toBe("widened");
  });

  it("treats an added anyOf branch as a widening and a removed one as a narrowing", () => {
    const one: JsonValue = { type: "object", properties: { v: { anyOf: [{ type: "string" }] } } };
    const two: JsonValue = { type: "object", properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } } };
    expect(classifySchemaChange(one, two)).toBe("widened");
    expect(classifySchemaChange(two, one)).toBe("narrowed");
  });

  it("reports the widening through the full diff, not just the classifier", () => {
    const before = lockOfTools([makeTool({ name: "read", inputSchema: refSchema() })]);
    const after = lockOfTools([makeTool({ name: "read", inputSchema: refSchema({ follow_symlinks: { type: "boolean" } }) })]);
    expect(diffLockfiles(before, after).map((change) => change.kind)).toEqual(["tool.input_schema.widened"]);
  });
});

describe("x-mcp-header behind indirection", () => {
  it("finds a mirrored parameter inside $defs", () => {
    const schema: JsonValue = {
      type: "object",
      $defs: { Args: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } } },
      $ref: "#/$defs/Args",
    };
    expect(extractHeaderParams(schema)).toEqual(["region -> Region"]);
  });

  it("finds one contributed by an allOf branch", () => {
    const schema: JsonValue = { type: "object", allOf: [{ properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } } }] };
    expect(extractHeaderParams(schema)).toEqual(["tenant -> Tenant"]);
  });

  it("finds one reachable only through an anyOf branch", () => {
    const schema: JsonValue = { type: "object", anyOf: [{ properties: { key: { type: "string", "x-mcp-header": "Key" } } }] };
    expect(extractHeaderParams(schema)).toEqual(["key -> Key"]);
  });

  it("surfaces it as a finding when a server adds it behind a $ref", () => {
    const plain = { type: "object" as const, $defs: { A: { type: "object", properties: { region: { type: "string" } } } }, $ref: "#/$defs/A" };
    const mirrored = {
      type: "object" as const,
      $defs: { A: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } } },
      $ref: "#/$defs/A",
    };
    const changes = diffLockfiles(lockOfTools([makeTool({ name: "q", inputSchema: plain })]), lockOfTools([makeTool({ name: "q", inputSchema: mirrored })]));
    expect(changes.map((change) => change.kind)).toContain("tool.header_params.changed");
  });
});
