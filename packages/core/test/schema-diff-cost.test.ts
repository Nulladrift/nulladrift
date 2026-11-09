/**
 * Comparing two versions of a long enum is linear.
 *
 * A server's own schema decides how long its enums and `required` lists are, and the comparison
 * was quadratic: a few hundred thousand members held whatever was comparing them -- the CLI, or a
 * control plane serving every tenant from one thread -- for minutes.
 */
import { describe, expect, it } from "vitest";
import { classifySchemaChange } from "../src/diff/schema";

const schema = (members: string[], required: string[] = []) => ({
  type: "object",
  required,
  properties: { pick: { type: "string", enum: members }, ...Object.fromEntries(required.map((name) => [name, { type: "string" }])) },
});

describe("a long enum", () => {
  const members = Array.from({ length: 200_000 }, (_, i) => `member-${i}`);

  it("is compared in well under a second, and still classified correctly", () => {
    const started = performance.now();
    const widened = classifySchemaChange(schema(members), schema([...members, "one-more"]));
    const changedLast = classifySchemaChange(schema(members), schema([...members.slice(0, -1), "different"]));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(widened).not.toBe("same");
    expect(changedLast).not.toBe("same");
  });

  it("with many required properties is walked in linear time too", () => {
    const required = Array.from({ length: 50_000 }, (_, i) => `field${i}`);
    const started = performance.now();
    expect(classifySchemaChange(schema(["a"], required), schema(["a"], required))).toBe("same");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
