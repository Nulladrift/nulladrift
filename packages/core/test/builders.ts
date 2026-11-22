/**
 * Lock entries built the way the collector builds them: the schema normalized, the header scan
 * run, every digest sealed. A hand-written digest lets a test pass against a lock the product
 * would never write.
 */
import { digest, toJson } from "../src/lock/canonical";
import { extractHeaderParams, normalizeSchema, resolveBehavior } from "../src/lock/normalize";
import { reseal } from "../src/lock/reseal";
import type { JsonObject, LockedAnnotations, LockedMcpServer, LockedTool, Lockfile } from "../src/lock/types";

export function tool(
  name: string,
  fields: { title?: string; description?: string; inputSchema?: unknown; annotations?: LockedAnnotations } = {},
): LockedTool {
  const inputSchema = normalizeSchema(toJson(fields.inputSchema ?? { type: "object" })) as JsonObject;
  const headerParams = extractHeaderParams(inputSchema);
  const body = {
    name,
    title: fields.title,
    description: fields.description,
    inputSchema,
    annotations: fields.annotations,
    behavior: resolveBehavior(fields.annotations),
    headerParams: headerParams.length > 0 ? headerParams : undefined,
  };
  return { ...body, digest: digest(toJson(body)) } as LockedTool;
}

export function server(fields: Partial<LockedMcpServer> = {}): LockedMcpServer {
  return reseal({
    kind: "mcp-server",
    source: { client: "generic", file: ".mcp.json" },
    transport: { type: "stdio", command: "npx", args: ["-y", "fs-server"] },
    protocol: { era: "modern", version: "2025-11-25" },
    serverInfo: { name: "fs", version: "1.0.0" },
    tools: [tool("read_file", { description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } })],
    digest: "",
    ...fields,
  } as LockedMcpServer) as LockedMcpServer;
}

export function lock(subjects: Record<string, LockedMcpServer>): Lockfile {
  return { lockfileVersion: 2, subjects } as Lockfile;
}
