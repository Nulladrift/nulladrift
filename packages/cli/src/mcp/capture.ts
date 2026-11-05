/** Asking a connected server for everything it exposes. */
import type { Client } from "@modelcontextprotocol/client";
import type { ConfiguredServer } from "../config/types";
import type { JsonObject, LockedProtocol, LockedServerInfo } from "../lock/types";
import { toJson } from "../lock/canonical";
import { connect, DEFAULT_TIMEOUT_MS } from "./connect";
import type { CapturedSurface } from "./types";
import { UnreachableServerError } from "./types";

/*
 * Lists are fetched with the cache bypassed. The SDK caches list results against the server's
 * `ttlMs` hint, which is exactly the wrong behaviour for an audit: a server could serve a stale
 * tool list and the check would pass against a surface nobody re-fetched.
 */
const FRESH = { cacheMode: "bypass" } as const;

async function listOrEmpty<T>(label: string, serverName: string, fetchList: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fetchList();
  } catch (error) {
    /*
     * A server that declares a capability and then fails the matching list call is not giving us
     * a surface to pin, so this is an audit failure rather than an empty section. Capability it
     * never declared returns an empty list from the SDK and never reaches here.
     */
    throw new UnreachableServerError(serverName, `${label} failed: ${(error as Error).message}`, error);
  }
}

function readProtocol(client: Client): LockedProtocol {
  const era = client.getProtocolEra() ?? "legacy";
  const version = client.getNegotiatedProtocolVersion() ?? "unknown";
  const discovered = client.getDiscoverResult();
  return {
    era,
    version,
    supportedVersions: discovered?.supportedVersions,
  };
}

function readServerInfo(client: Client): LockedServerInfo | undefined {
  const info = client.getServerVersion();
  if (!info) return undefined;
  return {
    name: info.name,
    title: info.title,
    version: info.version,
    description: info.description,
    websiteUrl: info.websiteUrl,
  };
}

export async function captureSurface(server: ConfiguredServer, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CapturedSurface> {
  const connection = await connect(server, timeoutMs);
  const { client } = connection;

  try {
    const capabilities = client.getServerCapabilities();

    /*
     * Only ask for what the server declares. A server MUST declare a capability it serves, the
     * SDK returns an empty list for anything undeclared, and asking anyway costs a round trip
     * per server and emits a warning per call -- which, across a few hundred servers, buries
     * everything else.
     */
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
      capabilities?.tools ? listOrEmpty("tools/list", server.name, async () => (await client.listTools(undefined, FRESH)).tools) : [],
      capabilities?.resources ? listOrEmpty("resources/list", server.name, async () => (await client.listResources(undefined, FRESH)).resources) : [],
      capabilities?.resources
        ? listOrEmpty("resources/templates/list", server.name, async () => (await client.listResourceTemplates(undefined, FRESH)).resourceTemplates)
        : [],
      capabilities?.prompts ? listOrEmpty("prompts/list", server.name, async () => (await client.listPrompts(undefined, FRESH)).prompts) : [],
    ]);

    return {
      protocol: readProtocol(client),
      serverInfo: readServerInfo(client),
      capabilities: capabilities ? (toJson(capabilities) as JsonObject) : undefined,
      // Clients place this in the model's system prompt, so it is part of the capability surface.
      instructions: client.getInstructions(),
      tools,
      resources,
      resourceTemplates,
      prompts,
    };
  } finally {
    await connection.close();
  }
}
