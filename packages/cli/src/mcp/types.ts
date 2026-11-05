import { UnauthorizedError } from "@modelcontextprotocol/client";
import type { Prompt, Resource, ResourceTemplateType as ResourceTemplate, Tool } from "@modelcontextprotocol/client";
import type { JsonObject, LockedProtocol, LockedServerInfo } from "../lock/types";

/** Everything one connection told us about a server. */
export interface CapturedSurface {
  protocol: LockedProtocol;
  serverInfo?: LockedServerInfo;
  capabilities?: JsonObject;
  instructions?: string;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
}

/** Why a server could not be captured. Separated from drift so CI can tell them apart. */
export class UnreachableServerError extends Error {
  constructor(
    readonly serverName: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "UnreachableServerError";
  }
}

/**
 * A server behind a credential is a different case from a server that is down: it is not drift
 * and it is not an outage, it is outside what this client was given access to. Reporting it as
 * "unreachable" sends people to check a network that is fine.
 */
export function isAuthFailure(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  // Thrown when a connection needs a browser and there is nobody at the keyboard.
  if (error instanceof Error && error.name === "InteractiveAuthRequiredError") return true;
  if (error instanceof UnreachableServerError && error.cause instanceof Error && error.cause.name === "InteractiveAuthRequiredError") return true;
  const cause = error instanceof UnreachableServerError ? error.cause : undefined;
  if (cause instanceof UnauthorizedError) return true;
  /*
   * Registration and discovery failures are authorization outcomes too: the server answered,
   * it just would not let this client in. Calling them outages sends people to check a network
   * that is fine.
   */
  for (const candidate of [error, error instanceof UnreachableServerError ? error.cause : undefined]) {
    const name = candidate instanceof Error ? candidate.name : "";
    if (name === "RegistrationRejectedError" || name === "InsufficientScopeError" || name === "OAuthClientFlowError") return true;
  }

  const text = `${error instanceof Error ? error.message : String(error)}`.toLowerCase();
  return /\b(401|403)\b|unauthorized|forbidden|invalid or missing.*token|authentication required|invalid_client|dynamic client registration/.test(text);
}
