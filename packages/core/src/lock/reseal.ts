/**
 * Recomputing every digest in a locked server from its own content.
 *
 * The diff engine short-circuits on digests, which is right when the lockfile and the reading
 * were produced by the same trusted process. The control plane is not in that position: it is
 * handed a surface by a collector running on the machine under audit, and a surface whose text
 * changed while its digests stayed still would otherwise compare as unchanged -- a clean verdict
 * on a tampered reading.
 *
 * So the control plane reseals both sides before diffing. Any digest the collector sent is
 * discarded and recomputed here, using the same canonicalization the collector used, so an
 * honest reading reseals to exactly the digests it arrived with.
 */
import { digest, toJson } from "./canonical";
import type { LockedMcpServer, LockedPrompt, LockedResource, LockedResourceTemplate, LockedSubject, LockedTool } from "./types";

/** Mirrors `sealed()` in the collector's builder: the digest covers the body without itself. */
function sealMember<T extends { digest?: string }>(member: T): T & { digest: string } {
  const { digest: _discarded, ...body } = member;
  return { ...(body as Omit<T, "digest">), digest: digest(toJson(body)) } as T & { digest: string };
}

/**
 * Resealing dispatches on what the subject is. One branch today; a kind added without a branch
 * here is a compile error rather than a surface that silently passes through unsealed, which
 * is the failure that would matter most.
 */
export function reseal(entry: LockedSubject): LockedSubject {
  switch (entry.kind) {
    case "mcp-server":
      return resealMcpServer(entry);
  }
}

function resealMcpServer(entry: LockedMcpServer): LockedMcpServer {
  const tools = (entry.tools ?? []).map((tool) => sealMember<LockedTool>(tool));
  const resources = (entry.resources ?? []).map((resource) => sealMember<LockedResource>(resource));
  const resourceTemplates = (entry.resourceTemplates ?? []).map((template) => sealMember<LockedResourceTemplate>(template));
  const prompts = (entry.prompts ?? []).map((prompt) => sealMember<LockedPrompt>(prompt));

  /*
   * `source` and `kind` are deliberately outside the digest, exactly as in the collector:
   * moving a server between config files is not a capability change, and neither is the format
   * learning a word for what it already held. That second exclusion is what lets a version 1
   * lock upgrade without every project reporting drift. Members contribute their digests rather
   * than their bodies, so resealing a large server stays linear.
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

  return {
    ...entry,
    tools: tools.length > 0 ? tools : undefined,
    resources: resources.length > 0 ? resources : undefined,
    resourceTemplates: resourceTemplates.length > 0 ? resourceTemplates : undefined,
    prompts: prompts.length > 0 ? prompts : undefined,
    digest: digest(toJson(covered)),
  };
}
