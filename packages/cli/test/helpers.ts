/**
 * Test builders. These go through the real `buildLockedServer` rather than hand-writing locked
 * entries, so a test cannot pass against a digest the product would never produce.
 */
import type { Prompt, Resource, ResourceTemplateType as ResourceTemplate, Tool } from "@modelcontextprotocol/client";
import type { ConfiguredServer, ConfiguredTransport } from "../src/config/types";
import { buildLockedServer } from "../src/lock/build";
import type { Lockfile, LockedMcpServer, LockPolicy } from "../src/lock/types";
import { LOCKFILE_VERSION } from "../src/lock/types";
import type { CapturedSurface } from "../src/mcp/types";

export function stdio(command = "npx", args: string[] = ["-y", "example-server"]): ConfiguredTransport {
  return { type: "stdio", command, args, env: {} };
}

export function http(url = "https://mcp.example.com/mcp"): ConfiguredTransport {
  return { type: "http", url, headers: {} };
}

export function configured(name: string, transport: ConfiguredTransport = stdio()): ConfiguredServer {
  return { name, source: { client: "claude-code", file: ".mcp.json", scope: "project" }, transport };
}

export function makeTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    ...overrides,
  } as Tool;
}

export function surface(overrides: Partial<CapturedSurface> = {}): CapturedSurface {
  return {
    protocol: { era: "modern", version: "2026-07-28", supportedVersions: ["2026-07-28"] },
    serverInfo: { name: "example-server", version: "1.0.0" },
    capabilities: { tools: { listChanged: true } },
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    ...overrides,
  };
}

export function lockWith(
  entries: Record<string, { config?: ConfiguredServer; surface: CapturedSurface }>,
  policy?: LockPolicy,
): Lockfile {
  const subjects: Record<string, LockedMcpServer> = {};
  for (const [name, entry] of Object.entries(entries)) {
    subjects[name] = buildLockedServer(entry.config ?? configured(name), entry.surface, policy);
  }
  return { lockfileVersion: LOCKFILE_VERSION, generatedBy: "nulladrift@test", policy, subjects };
}

/** One server called "example" holding the given tools, which is what most diff tests need. */
export function lockOfTools(tools: Tool[], overrides: Partial<CapturedSurface> = {}): Lockfile {
  return lockWith({ example: { surface: surface({ tools, ...overrides }) } });
}

export const RESOURCE: Resource = { uri: "file:///README.md", name: "readme", mimeType: "text/markdown" };
export const TEMPLATE: ResourceTemplate = { uriTemplate: "file:///project/{path}", name: "project-file" };
export const PROMPT: Prompt = { name: "summarize", description: "Summarize a file." };
