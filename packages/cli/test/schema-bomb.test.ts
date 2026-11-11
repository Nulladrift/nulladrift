/**
 * A small recursive schema stays cheap to pin, diff and scan.
 *
 * `{"$defs":{"n":{"properties":{"p0":{"$ref":"#/$defs/n"},...}}},"$ref":"#/$defs/n"}` cost the
 * header scan about P^12 calls: with four properties it was still running after 97 seconds, on a
 * blocked event loop that `--timeout` could not interrupt. Found in a security review. Fails
 * closed (a hang, not a clean result) but it stalls CI, and anything that walks a schema could do
 * the same, so the whole path is timed: lock builder, diff, capability scan.
 */
import { surfaceCapabilities } from "@nulladrift/core";
import { describe, expect, it } from "vitest";
import { diffLockfiles } from "../src/diff";
import { lockOfTools, makeTool } from "./helpers";

const bomb = (properties: number, description = "a node") => ({
  $defs: { n: { type: "object", description, properties: Object.fromEntries(Array.from({ length: properties }, (_, index) => [`p${index}`, { $ref: "#/$defs/n" }])) } },
  $ref: "#/$defs/n",
});

describe("a recursive schema", () => {
  it.each([4, 6, 10])("with %i self-referencing properties is pinned, diffed and scanned in well under a second", (properties) => {
    const started = performance.now();
    const before = lockOfTools([makeTool({ name: "t", inputSchema: bomb(properties) as never })]);
    const after = lockOfTools([makeTool({ name: "t", inputSchema: bomb(properties, "a node, rewritten") as never })]);
    const changes = diffLockfiles(before, after);
    surfaceCapabilities([makeTool({ name: "t", inputSchema: bomb(properties) as never })] as never);
    const elapsed = performance.now() - started;
    expect(changes.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

/*
 * The same hang by another route. Each `$defs` level lists the next one four times under `allOf`;
 * the ref guard only stopped a ref already on the current path, so sibling branches resolved the
 * same definition once per path to it: 4^16 resolutions for 1.8 KB, after the server had
 * answered, where `--timeout` could not reach. Found in a security review, at 25 seconds for
 * twelve levels and still running at 90 for sixteen.
 */
const fanOut = (levels: number, fan: number, extra = false) => {
  const $defs: Record<string, unknown> = {};
  for (let level = 0; level < levels; level += 1) {
    $defs[`d${level}`] = { allOf: Array.from({ length: fan }, () => ({ $ref: `#/$defs/d${level + 1}` })) };
  }
  $defs[`d${levels}`] = { type: "object", properties: { q: { type: "string" }, ...(extra ? { r: { type: "string" } } : {}) } };
  return { type: "object", $defs, allOf: [{ $ref: "#/$defs/d0" }] };
};

describe("a schema that fans out through allOf", () => {
  it.each([
    [12, 4],
    [16, 3],
    [16, 4],
  ])("%i levels of %i branches is pinned, diffed and scanned in well under a second", (levels, fan) => {
    const started = performance.now();
    const before = lockOfTools([makeTool({ name: "t", inputSchema: fanOut(levels, fan) as never })]);
    const after = lockOfTools([makeTool({ name: "t", inputSchema: fanOut(levels, fan, true) as never })]);
    const changes = diffLockfiles(before, after);
    surfaceCapabilities([makeTool({ name: "t", inputSchema: fanOut(levels, fan) as never })] as never);
    expect(changes.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
