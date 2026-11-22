/**
 * Which way a schema change cuts.
 *
 * The label decides severity: a widening is high, a narrowing low. Every case below was one where
 * the classifier called a widening a narrowing, or could not tell, so a server that lifted a guard
 * on its input was reported at the bottom of the list -- and a policy blocking on high let it
 * through. Found in a security review.
 */
import { describe, expect, it } from "vitest";
import { diffLockfiles } from "../src/diff";
import { classifySchemaChange } from "../src/diff/schema";
import { toJson } from "../src/lock/canonical";
import { normalizeSchema } from "../src/lock/normalize";
import type { JsonValue } from "../src/lock/types";
import { lock, server, tool } from "./builders";

const pin = (schema: unknown): JsonValue => normalizeSchema(toJson(schema));
const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "object", properties, ...extra });
const verdict = (before: unknown, after: unknown) => classifySchemaChange(pin(before), pin(after));

/*
 * An alternation is a constraint: the value must match one of its branches. Branches were read as
 * extra facts, so removing the whole alternation looked like removing facts -- a narrowing -- when
 * it lifted the constraint. Pydantic writes every `Optional[...]` this way.
 */
describe("an alternation taken away is a constraint lifted", () => {
  it.each([
    [
      "Optional[Literal['read']] -> str",
      obj({ mode: { anyOf: [{ type: "string", enum: ["read"] }, { type: "null" }], default: null } }),
      obj({ mode: { type: "string" } }),
    ],
    ["a union of literals -> any string", obj({ table: { anyOf: [{ const: "users" }, { const: "orders" }] } }), obj({ table: { type: "string" } })],
    ["oneOf of two enums -> any string", obj({ op: { type: "string", oneOf: [{ enum: ["get"] }, { enum: ["list"] }] } }), obj({ op: { type: "string" } })],
    ["an if/then guard removed", obj({ path: { type: "string", if: { pattern: "^/" }, then: { pattern: "^/srv/" } } }), obj({ path: { type: "string" } })],
    ["a not guard removed", obj({ p: { type: "string", not: { pattern: "\\.\\." } } }), obj({ p: { type: "string" } })],
    ["an items schema removed", obj({ ids: { type: "array", items: { type: "integer", maximum: 100 } } }), obj({ ids: { type: "array" } })],
  ])("%s is a widening", (_label, before, after) => {
    expect(verdict(before, after)).toBe("widened");
  });

  it.each([
    ["a not guard added", obj({ path: { type: "string" } }), obj({ path: { type: "string", not: { pattern: "\\.\\." } } })],
    ["an anyOf of literals added", obj({ mode: { type: "string" } }), obj({ mode: { type: "string", anyOf: [{ enum: ["a"] }, { enum: ["b"] }] } })],
    ["str -> Optional[Literal['read']]", obj({ mode: { type: "string" } }), obj({ mode: { anyOf: [{ type: "string", enum: ["read"] }, { type: "null" }] } })],
  ])("%s is a narrowing", (_label, before, after) => {
    expect(verdict(before, after)).toBe("narrowed");
  });

  it("still reads a branch added to an alternation both sides have as a widening, and one removed as a narrowing", () => {
    const one = obj({ v: { anyOf: [{ type: "string" }] } });
    const two = obj({ v: { anyOf: [{ type: "string" }, { type: "number" }] } });
    expect(verdict(one, two)).toBe("widened");
    expect(verdict(two, one)).toBe("narrowed");
  });

  it("reports run_query going from two allowed tables to any string as a high widening, end to end", () => {
    const allowed = obj({ table: { anyOf: [{ const: "users" }, { const: "orders" }] } });
    const anything = obj({ table: { type: "string" } });
    const changes = diffLockfiles(
      lock({ s: server({ tools: [tool("run_query", { description: "Run a query", inputSchema: allowed })] }) }),
      lock({ s: server({ tools: [tool("run_query", { description: "Run a query", inputSchema: anything })] }) }),
    );
    expect(changes.map((change) => [change.kind, change.severity])).toEqual([["tool.input_schema.widened", "high"]]);
  });
});

/*
 * Facts were keyed by names joined with "." and "|", so a property could be named after another
 * one's path and overwrite it: a new top-level argument called "opts.mode" put its enum where the
 * nested `opts.mode` had lost one, and the loss vanished.
 */
describe("a property named like another property's path", () => {
  it("does not hide a nested enum that was dropped", () => {
    const before = obj({ opts: obj({ mode: { type: "string", enum: ["read"] } }) });
    const after = obj({ opts: obj({ mode: { type: "string" } }), "opts.mode": { type: "string", enum: ["read"], maxLength: 4 } });
    expect(verdict(before, after)).toBe("widened");
  });

  it("does not hide a branch that lost its enum", () => {
    const before = obj({ cmd: { anyOf: [{ type: "string", enum: ["ls"] }] } });
    const after = obj({ cmd: { anyOf: [{ type: "string" }] }, "cmd|anyOf[0]": { type: "string", enum: ["ls"], maxLength: 2 } });
    expect(verdict(before, after)).toBe("widened");
  });
});

/*
 * `allOf` means every branch applies. Folding it let the first contributor win, so the looser of
 * two bounds was the one compared, and relaxing the tighter one read as a narrowing.
 */
describe("allOf is read as the intersection it is", () => {
  it("takes the tightest bound", () => {
    expect(verdict(obj({ note: { type: "string", allOf: [{ maxLength: 100 }, { maxLength: 5 }] } }), obj({ note: { type: "string", maxLength: 50 } }))).toBe("widened");
    expect(verdict(obj({ n: { type: "number", minimum: 0, allOf: [{ minimum: 10 }] } }), obj({ n: { type: "number", minimum: 5 } }))).toBe("widened");
  });

  it("intersects enums", () => {
    expect(verdict(obj({ op: { type: "string", enum: ["get", "list", "delete"], allOf: [{ enum: ["get"] }] } }), obj({ op: { type: "string", enum: ["get", "list"] } }))).toBe(
      "widened",
    );
  });

  it("does not let a constraint in a later branch disappear unseen", () => {
    const before = obj({ path: { type: "string", allOf: [{ pattern: "^/srv/" }, { pattern: "^/srv/data/" }] } });
    const after = obj({ path: { type: "string", allOf: [{ pattern: "^/srv/" }] } });
    expect(verdict(before, after)).toBe("widened");
  });
});

/*
 * Keywords the classifier had no slot for. Removing any of them only ever lets more through, and
 * that was reported as a bare `changed`: a path guard taken off a file tool ranked medium.
 */
describe("constraints the classifier did not model", () => {
  it.each([
    ["const removed", obj({ mode: { type: "string", const: "read" } }), obj({ mode: { type: "string" } })],
    ["pattern removed", obj({ path: { type: "string", pattern: "^/srv/data/[a-z]+$" } }), obj({ path: { type: "string" } })],
    ["format removed", obj({ url: { type: "string", format: "uri" } }), obj({ url: { type: "string" } })],
    ["exclusiveMaximum removed", obj({ n: { type: "number", exclusiveMaximum: 10 } }), obj({ n: { type: "number" } })],
    ["exclusiveMinimum loosened", obj({ n: { type: "number", exclusiveMinimum: 10 } }), obj({ n: { type: "number", exclusiveMinimum: 1 } })],
    ["maxItems removed", obj({ ids: { type: "array", items: { type: "string" }, maxItems: 1 } }), obj({ ids: { type: "array", items: { type: "string" } } })],
    ["minItems loosened", obj({ ids: { type: "array", minItems: 2 } }), obj({ ids: { type: "array", minItems: 1 } })],
    ["uniqueItems removed", obj({ ids: { type: "array", uniqueItems: true } }), obj({ ids: { type: "array" } })],
    ["multipleOf removed", obj({ n: { type: "integer", multipleOf: 5 } }), obj({ n: { type: "integer" } })],
    ["additionalProperties false -> a schema", obj({ a: { type: "string" } }, { additionalProperties: false }), obj({ a: { type: "string" } }, { additionalProperties: { type: "string" } })],
    ["additionalProperties a schema -> true", obj({ a: { type: "string" } }, { additionalProperties: { type: "string" } }), obj({ a: { type: "string" } }, { additionalProperties: true })],
    ["additionalProperties schema loosened", obj({}, { additionalProperties: { type: "string", maxLength: 3 } }), obj({}, { additionalProperties: { type: "string" } })],
    [
      "patternProperties added beside additionalProperties false",
      obj({ a: { type: "string" } }, { additionalProperties: false }),
      obj({ a: { type: "string" } }, { additionalProperties: false, patternProperties: { "^x-": {} } }),
    ],
    ["integer -> number", obj({ n: { type: "integer" } }), obj({ n: { type: "number" } })],
  ])("%s is a widening", (_label, before, after) => {
    expect(verdict(before, after)).toBe("widened");
  });

  it.each([
    ["pattern added", obj({ path: { type: "string" } }), obj({ path: { type: "string", pattern: "^/srv/" } })],
    ["number -> integer", obj({ n: { type: "number" } }), obj({ n: { type: "integer" } })],
    ["const added", obj({ mode: { type: "string" } }), obj({ mode: { type: "string", const: "read" } })],
  ])("%s is a narrowing", (_label, before, after) => {
    expect(verdict(before, after)).toBe("narrowed");
  });

  it("calls a changed pattern a change, since neither direction can be shown", () => {
    expect(verdict(obj({ path: { type: "string", pattern: "^/srv/" } }), obj({ path: { type: "string", pattern: "^/home/" } }))).toBe("changed");
  });

  it("does not let a narrowing elsewhere hide a lifted guard", () => {
    const before = obj({ path: { type: "string", pattern: "^/srv/" }, n: { type: "integer" } });
    const after = obj({ path: { type: "string" }, n: { type: "integer", maximum: 10 } });
    expect(verdict(before, after)).toBe("changed");
  });
});
