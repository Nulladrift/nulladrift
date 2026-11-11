/** Turning a captured surface into the entry that goes in `mcp.lock`. */
import type { Prompt, Resource, ResourceTemplateType as ResourceTemplate, Tool } from "@modelcontextprotocol/client";
import type { ConfiguredServer } from "../config/types";
import type { CapturedSurface } from "../mcp/types";
import { digest, toJson } from "./canonical";
import { redactArgs } from "./credentials";
import { extractHeaderParams, normalizeSchema, resolveBehavior, sanitizeUrl, stripIgnoredMeta } from "./normalize";
import type {
  JsonObject,
  LockedAnnotations,
  LockedIcon,
  LockedPrompt,
  LockedResource,
  LockedResourceTemplate,
  LockedMcpServer,
  LockedTool,
  LockedTransport,
  LockPolicy,
} from "./types";

/** Members are stored sorted by name so that a server reordering its list is not a whole-file diff. */
function byName<T extends { name: string }>(members: T[]): T[] {
  return [...members].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function lockIcons(icons: Tool["icons"]): LockedIcon[] | undefined {
  if (!icons || icons.length === 0) return undefined;
  return icons.map((icon) => ({
    src: icon.src,
    mimeType: icon.mimeType,
    sizes: icon.sizes,
    theme: icon.theme,
  }));
}

/** Every member's digest covers its own locked fields; the digest itself is added afterwards. */
function sealed<T extends object>(entry: T): T & { digest: string } {
  return { ...entry, digest: digest(toJson(entry)) };
}

/**
 * What a server is reached by, written down without the credentials used to reach it.
 *
 * Environment values and header values were never stored, only their names, and a URL loses its
 * query and fragment. `args` were stored expanded, which undid all of that: a config keeps a
 * secret out of the repository by writing `--token=${API_KEY}`, and this wrote the expanded value
 * into `mcp.lock`, which is the file the README tells you to commit.
 *
 * So the configured form is what gets written down -- `${API_KEY}`, the thing the author chose to
 * put in version control -- while the expanded form is only ever used to start the process. A
 * config that changes which variable it reads is still drift, and is still visible.
 */
export function lockTransport(server: ConfiguredServer): LockedTransport {
  const { transport } = server;
  if (transport.type === "stdio") {
    const command = transport.asWritten?.command ?? transport.command;
    // A credential written literally in the config is left out too; see redactArgs.
    const args = redactArgs(transport.asWritten?.args ?? transport.args);
    return {
      type: "stdio",
      command,
      args: args.length > 0 ? args : undefined,
      envKeys: Object.keys(transport.env).length > 0 ? Object.keys(transport.env).sort() : undefined,
      cwd: transport.asWritten ? transport.asWritten.cwd : transport.cwd,
    };
  }
  const headerKeys = Object.keys(transport.headers);
  return {
    type: transport.type,
    url: sanitizeUrl(transport.asWritten?.url ?? transport.url),
    headerKeys: headerKeys.length > 0 ? headerKeys.sort() : undefined,
  };
}

function lockTool(tool: Tool, ignoredMeta: readonly string[]): LockedTool {
  const annotations = tool.annotations as LockedAnnotations | undefined;
  const inputSchema = normalizeSchema(toJson(tool.inputSchema)) as JsonObject;
  const headerParams = extractHeaderParams(inputSchema);

  return sealed({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema,
    outputSchema: tool.outputSchema ? (normalizeSchema(toJson(tool.outputSchema)) as JsonObject) : undefined,
    annotations: annotations ? ({ ...annotations } as LockedAnnotations) : undefined,
    behavior: resolveBehavior(annotations),
    headerParams: headerParams.length > 0 ? headerParams : undefined,
    icons: lockIcons(tool.icons),
    execution: (tool as { execution?: unknown }).execution ? (toJson((tool as { execution?: unknown }).execution) as JsonObject) : undefined,
    meta: stripIgnoredMeta(toJson(tool._meta), ignoredMeta),
  });
}

function lockResource(resource: Resource, ignoredMeta: readonly string[]): LockedResource {
  return sealed({
    uri: resource.uri,
    name: resource.name,
    title: resource.title,
    description: resource.description,
    mimeType: resource.mimeType,
    annotations: resource.annotations ? (toJson(resource.annotations) as JsonObject) : undefined,
    icons: lockIcons(resource.icons),
    meta: stripIgnoredMeta(toJson(resource._meta), ignoredMeta),
  });
}

function lockResourceTemplate(template: ResourceTemplate, ignoredMeta: readonly string[]): LockedResourceTemplate {
  return sealed({
    uriTemplate: template.uriTemplate,
    name: template.name,
    title: template.title,
    description: template.description,
    mimeType: template.mimeType,
    annotations: template.annotations ? (toJson(template.annotations) as JsonObject) : undefined,
    icons: lockIcons(template.icons),
    meta: stripIgnoredMeta(toJson(template._meta), ignoredMeta),
  });
}

function lockPrompt(prompt: Prompt, ignoredMeta: readonly string[]): LockedPrompt {
  return sealed({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments:
      prompt.arguments && prompt.arguments.length > 0
        ? prompt.arguments.map((argument) => ({
            name: argument.name,
            // The spec gives PromptArgument a `title` (it extends BaseMetadata); the SDK's type
            // has not caught up, so it is read off the wire rather than skipped.
            title: (argument as { title?: string }).title,
            description: argument.description,
            required: argument.required,
          }))
        : undefined,
    icons: lockIcons(prompt.icons),
    meta: stripIgnoredMeta(toJson(prompt._meta), ignoredMeta),
  });
}

export function buildLockedServer(server: ConfiguredServer, surface: CapturedSurface, policy?: LockPolicy): LockedMcpServer {
  const ignoredMeta = policy?.ignoreMetaPrefixes ?? [];

  const tools = byName(surface.tools).map((tool) => lockTool(tool, ignoredMeta));
  const resources = byName(surface.resources).map((resource) => lockResource(resource, ignoredMeta));
  const resourceTemplates = byName(surface.resourceTemplates).map((template) => lockResourceTemplate(template, ignoredMeta));
  const prompts = byName(surface.prompts).map((prompt) => lockPrompt(prompt, ignoredMeta));

  const entry = {
    source: server.source,
    transport: lockTransport(server),
    protocol: surface.protocol,
    serverInfo: surface.serverInfo,
    capabilities: surface.capabilities,
    instructions: surface.instructions,
    tools: tools.length > 0 ? tools : undefined,
    resources: resources.length > 0 ? resources : undefined,
    resourceTemplates: resourceTemplates.length > 0 ? resourceTemplates : undefined,
    prompts: prompts.length > 0 ? prompts : undefined,
  };

  /*
   * The server digest deliberately leaves out `source`: moving a server between config files is
   * not a capability change, and breaking the digest for it would make a file reorganisation
   * look like a security event. Members contribute their digests rather than their full bodies,
   * so the cost of sealing a large server stays linear.
   */
  const covered = {
    transport: entry.transport,
    protocol: entry.protocol,
    serverInfo: entry.serverInfo,
    capabilities: entry.capabilities,
    instructions: entry.instructions,
    tools: tools.map((tool) => tool.digest),
    resources: resources.map((resource) => resource.digest),
    resourceTemplates: resourceTemplates.map((template) => template.digest),
    prompts: prompts.map((prompt) => prompt.digest),
  };

  // Outside the digest: how much was seen is not part of what was seen.
  return { kind: "mcp-server", ...entry, ...(surface.coverage ? { coverage: surface.coverage } : {}), digest: digest(toJson(covered)) };
}
