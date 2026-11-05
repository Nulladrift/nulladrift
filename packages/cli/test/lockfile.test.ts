/**
 * The lockfile as a published contract: deterministic bytes, a readable layout, and conformance
 * to schema/mcp.lock.schema.json, which is the thing other people will read.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import { LockfileError, parseLockfile, serializeLockfile } from "../src/lock/io";
import type { Lockfile } from "../src/lock/types";
import { lockOfTools, lockWith, makeTool, surface, PROMPT, RESOURCE, TEMPLATE } from "./helpers";

const SCHEMA_URL = new URL("../../../schema/mcp.lock.schema.json", import.meta.url);
const EXAMPLE_URL = new URL("../../../examples/mcp.lock", import.meta.url);

let validate: (data: unknown) => boolean;
let errorsOf: () => string;

beforeAll(async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const compiled = ajv.compile(JSON.parse(await readFile(fileURLToPath(SCHEMA_URL), "utf8")) as object);
  validate = (data) => compiled(data) as boolean;
  errorsOf = () => JSON.stringify(compiled.errors, null, 2);
});

const RICH = lockWith({
  payments: {
    surface: surface({
      instructions: "Confirm the amount before calling create_refund.",
      tools: [
        makeTool({
          name: "create_refund",
          title: "Create Refund",
          description: "Issue a refund against a settled charge.",
          inputSchema: {
            type: "object",
            properties: { charge_id: { type: "string" }, region: { type: "string", "x-mcp-header": "Region" } },
            required: ["region", "charge_id"],
            additionalProperties: false,
          },
          outputSchema: { type: "object", properties: { refund_id: { type: "string" } } },
          annotations: { destructiveHint: true, openWorldHint: true },
          icons: [{ src: "https://example.com/icon.png", mimeType: "image/png", sizes: ["48x48"] }],
        }),
      ],
      resources: [RESOURCE],
      resourceTemplates: [TEMPLATE],
      prompts: [PROMPT],
    }),
  },
});

describe("conformance to the published JSON Schema", () => {
  it("validates a freshly generated lockfile", () => {
    expect(validate(JSON.parse(serializeLockfile(RICH))), errorsOf()).toBe(true);
  });

  it("validates the committed example", async () => {
    const example = JSON.parse(await readFile(fileURLToPath(EXAMPLE_URL), "utf8")) as unknown;
    expect(validate(example), errorsOf()).toBe(true);
  });
});

describe("the worked example", () => {
  it("is exactly what the product writes today", async () => {
    // Generated, not hand-written: a documented format that the code no longer produces is
    // worse than no example at all. `pnpm example:emit` regenerates it.
    const { buildExampleLockfile } = await import("../src/scripts/emit-example");
    const committed = await readFile(fileURLToPath(EXAMPLE_URL), "utf8");
    expect(serializeLockfile(buildExampleLockfile())).toBe(committed);
  });
});

describe("determinism", () => {
  it("produces identical bytes for the same content", () => {
    expect(serializeLockfile(RICH)).toBe(serializeLockfile(RICH));
  });

  it("is insensitive to the order servers were inserted in", () => {
    const a: Lockfile = { ...RICH, subjects: { alpha: RICH.subjects["payments"]!, zulu: RICH.subjects["payments"]! } };
    const b: Lockfile = { ...RICH, subjects: { zulu: RICH.subjects["payments"]!, alpha: RICH.subjects["payments"]! } };
    expect(serializeLockfile(a)).toBe(serializeLockfile(b));
  });

  it("writes no timestamp, so a re-run does not dirty the file", () => {
    const text = serializeLockfile(RICH);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toMatch(/generatedAt|capturedAt|timestamp/i);
  });
});

describe("layout", () => {
  const text = serializeLockfile(RICH);

  it("leads each tool with its name and ends it with its digest", () => {
    const entry = text.slice(text.indexOf('"tools"'));
    expect(entry.indexOf('"name"')).toBeLessThan(entry.indexOf('"description"'));
    expect(entry.indexOf('"description"')).toBeLessThan(entry.indexOf('"inputSchema"'));
    expect(entry.indexOf('"behavior"')).toBeLessThan(entry.indexOf('"digest"'));
  });

  it("sorts free-form subtrees such as JSON Schemas", () => {
    // `additionalProperties`, `properties`, `required`, `type` -- alphabetical, so that a server
    // reserializing its schema produces no diff.
    const schema = text.slice(text.indexOf('"inputSchema"'));
    expect(schema.indexOf('"additionalProperties"')).toBeLessThan(schema.indexOf('"properties"'));
    expect(schema.indexOf('"properties"')).toBeLessThan(schema.indexOf('"required"'));
  });

  it("writes the resolved behaviour in full, so a removed annotation reads as a change", () => {
    expect(text).toContain('"behavior"');
    for (const key of ["readOnly", "destructive", "idempotent", "openWorld"]) expect(text).toContain(`"${key}"`);
  });

  it("surfaces x-mcp-header parameters on their own line", () => {
    expect(text).toContain('"headerParams": ["region -> Region"]');
  });
});

describe("round trip", () => {
  it("parses what it serialized, digests intact", () => {
    const parsed = parseLockfile(serializeLockfile(RICH), "mcp.lock");
    expect(parsed.subjects["payments"]?.digest).toBe(RICH.subjects["payments"]?.digest);
    expect(serializeLockfile(parsed)).toBe(serializeLockfile(RICH));
  });
});

describe("refusing what it does not understand", () => {
  it("rejects a future lockfileVersion instead of guessing", () => {
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 99, subjects: {} }), "mcp.lock")).toThrow(LockfileError);
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 99, subjects: {} }), "mcp.lock")).toThrow(/Upgrade nulladrift/);
  });

  it("rejects malformed JSON with the path in the message", () => {
    expect(() => parseLockfile("{not json", "some/mcp.lock")).toThrow(/some\/mcp\.lock is not valid JSON/);
  });

  it("rejects a hand-edited digest that is not a digest", () => {
    const broken = JSON.parse(serializeLockfile(lockOfTools([makeTool({ name: "t" })]))) as Record<string, any>;
    broken["subjects"]["example"]["digest"] = "nope";
    expect(() => parseLockfile(JSON.stringify(broken), "mcp.lock")).toThrow(/sha256 digest/);
  });
});
