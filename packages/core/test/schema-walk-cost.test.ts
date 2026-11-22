/**
 * Walking a schema costs what the schema weighs, not what its references multiply out to.
 *
 * Everything that reads a tool's schema -- the widening classifier, the header scan, the
 * capability scan -- runs synchronously, after the server has answered, on the thread the control
 * plane serves every tenant from. A schema that turns a few hundred bytes into minutes of work is
 * an outage for everybody, and no timeout can interrupt it. Both shapes below were found in a
 * security review; each held its caller for over a minute.
 */
import { describe, expect, it } from "vitest";
import { classifySchemaChange } from "../src/diff/schema";
import { toJson } from "../src/lock/canonical";
import { extractHeaderParams, normalizeSchema } from "../src/lock/normalize";
import type { JsonValue } from "../src/lock/types";
import { toolCapabilities } from "../src/risk/capability";

const pin = (schema: unknown): JsonValue => normalizeSchema(toJson(schema));

const timed = <T>(work: () => T): { result: T; ms: number } => {
  const started = performance.now();
  const result = work();
  return { result, ms: performance.now() - started };
};

/*
 * Property names that spell other paths. Facts were keyed by names joined with ".", so "a.a"
 * under the root and "a" under "a" were one fact, and every route of the same length collapsed
 * into one. The ceiling counted distinct facts, which stayed in single figures while the routes
 * to them grew as m^12: 112 bytes held `check` for 82 seconds.
 */
describe("property names that spell another property's path", () => {
  const dotted = (description?: string) =>
    pin({ type: "object", description, properties: Object.fromEntries(["a", "a.a", "a.a.a", "a.a.a.a"].map((name) => [name, { $ref: "#" }])) });

  it("are classified in well under a second", () => {
    const before = dotted();
    const after = dotted("rewritten");
    expect(JSON.stringify(before).length).toBeLessThanOrEqual(112);
    const { result, ms } = timed(() => classifySchemaChange(before, after));
    expect(ms).toBeLessThan(500);
    // Only an annotation moved, so no direction can be claimed.
    expect(result).toBe("changed");
  });
});

/*
 * Properties that are each the whole schema again. The header scan counted the nodes it walked,
 * but every walk asked for the effective schema of each child, and each of those re-merged the
 * root's N properties: N^3 for N = 800 is 16 KB that held `init` for 87 seconds.
 */
describe("a schema whose every property is the whole schema again", () => {
  const fan = (count: number, extra: Record<string, unknown> = {}) =>
    pin({ type: "object", properties: { ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, { $ref: "#" }])), ...extra } });

  it("is scanned for headers in well under a second at 800 properties", () => {
    const schema = fan(800);
    expect(JSON.stringify(schema).length).toBeLessThan(17_000);
    const { result, ms } = timed(() => extractHeaderParams(schema));
    expect(ms).toBeLessThan(500);
    expect(result).toEqual([]);
  });

  it("is classified and scanned for capabilities in well under a second at 800 properties", () => {
    const { ms } = timed(() => {
      classifySchemaChange(fan(800), fan(800, { extra: { type: "string" } }));
      toolCapabilities({ name: "t", inputSchema: fan(800) });
    });
    expect(ms).toBeLessThan(500);
  });

  it("is still bounded when each property also carries keywords of its own", () => {
    // Own keywords beside the `$ref` force a merge rather than a shared copy.
    const schema = pin({
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`p${i}`, { $ref: "#", description: `p${i}`, properties: { [`q${i}`]: {} } }])),
    });
    const { ms } = timed(() => {
      extractHeaderParams(schema);
      classifySchemaChange(schema, pin({ ...(schema as object), description: "x" }));
      toolCapabilities({ name: "t", inputSchema: schema });
    });
    expect(ms).toBeLessThan(1_000);
  });

  /*
   * The budget that bounds this is per schema, and the collector runs the header scan on the very
   * object a fresh reading is then compared with. Shared, a budget the scan had spent made the two
   * sides read differently, and an annotation-only change on a hostile schema came out "widened".
   */
  it("is read the same by the classifier whatever an earlier reader spent", () => {
    // `tags.items` is read by the classifier and never by the header scan, which does not walk
    // `items`; the thousand properties after it spend the budget.
    const shape = {
      type: "object",
      $defs: { Tag: { type: "string", maxLength: 5 } },
      properties: {
        tags: { type: "array", items: { $ref: "#/$defs/Tag" } },
        ...Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`p${i}`, { $ref: "#", description: `p${i}`, properties: { [`q${i}`]: {} } }])),
      },
    };
    const pair = () => [pin(shape), pin({ ...shape, description: "rewritten" })] as const;
    const untouched = pair();
    expect(classifySchemaChange(untouched[0], untouched[1])).toBe("changed");
    for (const scanned of [0, 1] as const) {
      const sides = pair();
      extractHeaderParams(sides[scanned]);
      expect(classifySchemaChange(sides[0], sides[1])).toBe("changed");
    }
  });

  /*
   * The scan's answer is part of the tool's digest, so making it fast must not change it: a lock
   * written before would drift on the first run after an upgrade. Each property carries its own
   * header and recurses once, which the scan reports at both levels.
   */
  it("finds exactly the headers it found before it was made fast", () => {
    const schema = pin({
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, { $ref: "#", "x-mcp-header": `H${i}` }])),
    });
    const found = extractHeaderParams(schema);
    expect(found).toHaveLength(420);
    expect(found).toContain("p0 -> H0");
    expect(found).toContain("p3.p17 -> H17");
    expect(found.some((entry) => entry.split(".").length > 2)).toBe(false);
  });
});
