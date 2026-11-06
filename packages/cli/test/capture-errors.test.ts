/*
 * When a server's reply does not match the specification, the SDK raises the validator's own
 * issue array and it reached the operator verbatim: forty lines of `code`, `values` and `path`
 * for what is usually one mistake repeated once per tool. It buried the finding, buried every
 * other server in the report under it, and read like a crash in this tool rather than a defect in
 * the server being audited.
 *
 * The example is real: every tool in `@modelcontextprotocol/server-filesystem@2025.8.21`
 * declares an `inputSchema` whose `type` is not `"object"`.
 */
import { describe, expect, it } from "vitest";
import { describeListFailure } from "../src/mcp/capture";

const issue = (index: number) => ({
  code: "invalid_value",
  values: ["object"],
  path: ["tools", index, "inputSchema", "type"],
  message: 'Invalid input: expected "object"',
});

const realFailure = new Error(`Invalid result for tools/list: ${JSON.stringify(Array.from({ length: 13 }, (_, i) => issue(i)), null, 2)}`);

describe("a validation failure is said once, not dumped", () => {
  const text = describeListFailure(realFailure);

  it("names the field that failed, in a path somebody can go and look at", () => {
    expect(text).toContain("tools[0].inputSchema.type");
  });

  it("keeps the validator's own words about what was wrong", () => {
    expect(text).toContain('expected "object"');
  });

  it("collapses the same defect repeated once per tool", () => {
    expect(text).toContain("and 12 more like it");
  });

  it("says whose defect it is, because the operator cannot fix it here", () => {
    expect(text).toContain("defect in the server");
  });

  it("fits on a line or two instead of forty", () => {
    expect(text.split("\n")).toHaveLength(1);
    expect(text.length).toBeLessThan(400);
  });

  it("does not leak the raw issue array", () => {
    expect(text).not.toContain("invalid_value");
    expect(text).not.toContain('"path"');
  });
});

describe("it only rewrites what it understands", () => {
  it("leaves an ordinary error alone", () => {
    expect(describeListFailure(new Error("connect ECONNREFUSED 127.0.0.1:9"))).toBe("connect ECONNREFUSED 127.0.0.1:9");
  });

  it("keeps the deep-nesting message, which has its own wording", () => {
    expect(describeListFailure(new RangeError("Maximum call stack size exceeded"))).toContain("nested too deeply");
  });

  it("falls back to the original when the array will not parse", () => {
    const broken = new Error("Invalid result for tools/list: [ not json");
    expect(describeListFailure(broken)).toBe(broken.message);
  });

  it("falls back when the array is empty, rather than claiming a problem it cannot name", () => {
    const empty = new Error("Invalid result for tools/list: []");
    expect(describeListFailure(empty)).toBe(empty.message);
  });

  it("reports several distinct problems rather than only the first", () => {
    const mixed = new Error(
      `Invalid result for tools/list: ${JSON.stringify([
        { path: ["tools", 0, "name"], message: "Required" },
        { path: ["tools", 1, "inputSchema"], message: "Expected object" },
      ])}`,
    );
    const described = describeListFailure(mixed);
    expect(described).toContain("tools[0].name");
    expect(described).toContain("tools[1].inputSchema");
  });

  it("survives issues with no path and no message", () => {
    const bare = new Error(`Invalid result for tools/list: ${JSON.stringify([{}])}`);
    expect(() => describeListFailure(bare)).not.toThrow();
  });
});
