/**
 * Runtime validation for a lockfile we are reading back.
 *
 * schema/mcp.lock.schema.json is the published contract and the thing to read to understand the
 * format; this is the parser that guards against a hand-edited or truncated file. They are kept
 * honest by a test that validates freshly generated locks against the published JSON Schema.
 */
import { CAPABILITY_KINDS } from "@nulladrift/core";
import { z } from "zod";
import type { JsonValue } from "./types";
import { LOCKFILE_VERSION } from "./types";

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
const jsonObject = z.record(z.string(), jsonValue);
const digestString = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 digest");

const icon = z.object({
  src: z.string(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

const annotations = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

const behavior = z.object({
  readOnly: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  openWorld: z.boolean(),
});

const tool = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: jsonObject,
  outputSchema: jsonObject.optional(),
  annotations: annotations.optional(),
  behavior,
  headerParams: z.array(z.string()).optional(),
  icons: z.array(icon).optional(),
  meta: jsonObject.optional(),
  digest: digestString,
});

const resource = z.object({
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  annotations: jsonObject.optional(),
  icons: z.array(icon).optional(),
  meta: jsonObject.optional(),
  digest: digestString,
});

const resourceTemplate = resource.omit({ uri: true }).extend({ uriTemplate: z.string() });

const prompt = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  arguments: z
    .array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
  icons: z.array(icon).optional(),
  meta: jsonObject.optional(),
  digest: digestString,
});

const transport = z.union([
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    envKeys: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.enum(["http", "sse"]),
    url: z.string(),
    headerKeys: z.array(z.string()).optional(),
  }),
]);

const server = z.object({
  kind: z.literal("mcp-server"),
  source: z.object({
    client: z.enum(["claude-code", "claude-desktop", "vscode", "cursor", "copilot", "windsurf", "generic", "manual"]),
    file: z.string(),
    scope: z.enum(["project", "user", "local"]).optional(),
  }),
  transport,
  protocol: z.object({
    era: z.enum(["modern", "legacy"]),
    version: z.string(),
    supportedVersions: z.array(z.string()).optional(),
  }),
  serverInfo: z
    .object({
      name: z.string().optional(),
      title: z.string().optional(),
      version: z.string().optional(),
      description: z.string().optional(),
      websiteUrl: z.string().optional(),
    })
    .optional(),
  capabilities: jsonObject.optional(),
  instructions: z.string().optional(),
  tools: z.array(tool).optional(),
  resources: z.array(resource).optional(),
  resourceTemplates: z.array(resourceTemplate).optional(),
  prompts: z.array(prompt).optional(),
  digest: digestString,
});

export const lockfileSchema = z.object({
  /*
   * An unknown version is refused rather than read optimistically: a format we do not understand
   * is exactly the case where guessing produces a confident wrong answer about what changed.
   */
  lockfileVersion: z.literal(LOCKFILE_VERSION),
  generatedBy: z.string().optional(),
  policy: z
    .object({
      ignoreMetaPrefixes: z.array(z.string()).optional(),
      allowUnreachable: z.boolean().optional(),
      /*
       * Validated against the real list rather than accepted as free strings: a policy with
       * `process_exec` in it would otherwise parse, forbid nothing, and read in the diff of
       * whoever added it as though the rule were in force.
       */
      deniedCapabilities: z.array(z.enum(CAPABILITY_KINDS)).optional(),
    })
    .optional(),
  /*
   * One map for everything pinned, each entry saying what it is. `z.discriminatedUnion` on a
   * union of one looks odd now and is the point: a second kind is a new member here, and every
   * switch over the result stops compiling until it handles it.
   */
  subjects: z.record(z.string(), z.discriminatedUnion("kind", [server])),
});
