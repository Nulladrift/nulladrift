/**
 * Regenerates examples/mcp.lock through the real builder.
 *
 * The example is the first thing anyone evaluating the format reads, so it is generated rather
 * than written by hand: hand-written digests would be decorative, and a format change would
 * leave the documentation describing a file the product no longer writes. CI runs this and
 * fails on a diff.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ConfiguredServer } from "../config/types";
import { buildLockedServer } from "../lock/build";
import { serializeLockfile } from "../lock/io";
import type { Lockfile, LockedMcpServer } from "../lock/types";
import { LOCKFILE_VERSION } from "../lock/types";
import type { CapturedSurface } from "../mcp/types";
import { VERSION } from "../lib/version";

const OUTPUT = new URL("../../../../examples/mcp.lock", import.meta.url);

const filesystem: { config: ConfiguredServer; surface: CapturedSurface } = {
  config: {
    name: "filesystem",
    source: { client: "claude-code", file: ".mcp.json", scope: "project" },
    transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "./src"], env: {} },
  },
  surface: {
    protocol: { era: "modern", version: "2026-07-28", supportedVersions: ["2026-07-28", "2025-11-25"] },
    serverInfo: { name: "secure-filesystem-server", version: "0.9.4" },
    capabilities: { resources: { listChanged: true }, tools: { listChanged: true } },
    instructions: "Use read_file to inspect source before proposing edits. Paths are resolved relative to the allowed roots.",
    tools: [
      {
        name: "list_directory",
        title: "List Directory",
        description: "List the files and subdirectories of a directory inside the allowed roots.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Directory to list." } }, required: ["path"], additionalProperties: false },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "read_file",
        title: "Read File",
        description: "Read the complete contents of a file from the allowed directories.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Absolute or workspace-relative path." } },
          required: ["path"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { contents: { type: "string" }, encoding: { type: "string", enum: ["utf-8", "base64"] } },
          required: ["contents"],
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "write_file",
        title: "Write File",
        description: "Create a new file or overwrite an existing file in the allowed directories.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" } }, required: ["path", "contents"], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
    ],
    resources: [],
    resourceTemplates: [{ uriTemplate: "file:///{path}", name: "workspace-file", description: "Any file beneath an allowed root.", mimeType: "text/plain" }],
    prompts: [],
  },
};

const payments: { config: ConfiguredServer; surface: CapturedSurface } = {
  config: {
    name: "payments",
    source: { client: "vscode", file: ".vscode/mcp.json" },
    transport: { type: "http", url: "https://mcp.example-payments.com/mcp", headers: { Authorization: "Bearer redacted" } },
  },
  surface: {
    protocol: { era: "modern", version: "2026-07-28", supportedVersions: ["2026-07-28"] },
    serverInfo: { name: "example-payments", version: "4.2.0", websiteUrl: "https://example-payments.com" },
    capabilities: { tools: { listChanged: true }, extensions: { "io.modelcontextprotocol/tasks": {} } },
    instructions: "Always confirm the amount and currency with the user before calling create_refund.",
    tools: [
      {
        name: "create_refund",
        title: "Create Refund",
        description: "Issue a refund against a settled charge. Refunds are irreversible once submitted.",
        inputSchema: {
          type: "object",
          properties: {
            charge_id: { type: "string" },
            amount_minor: { type: "integer", minimum: 1 },
            region: { type: "string", description: "Processing region.", "x-mcp-header": "Region" },
          },
          required: ["charge_id", "amount_minor", "region"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
    ],
    resources: [],
    resourceTemplates: [],
    prompts: [],
  },
};

export function buildExampleLockfile(): Lockfile {
  const subjects: Record<string, LockedMcpServer> = {};
  for (const entry of [filesystem, payments]) {
    subjects[entry.config.name] = buildLockedServer(entry.config, entry.surface);
  }
  return { lockfileVersion: LOCKFILE_VERSION, generatedBy: `nulladrift@${VERSION}`, subjects };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(OUTPUT, serializeLockfile(buildExampleLockfile()), "utf8");
  process.stdout.write(`wrote ${fileURLToPath(OUTPUT)}\n`);
}
