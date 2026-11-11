import { UnauthorizedError } from "@modelcontextprotocol/client";
import type { Prompt, Resource, ResourceTemplateType as ResourceTemplate, Tool } from "@modelcontextprotocol/client";
import type { JsonObject, LockedCoverage, LockedProtocol, LockedServerInfo } from "../lock/types";

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
  /** Set only when the listing is known not to be the whole surface; see LockedCoverage. */
  coverage?: LockedCoverage;
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

/** How a server refused the audit, when it refused on authorization grounds rather than by being down. */
export type AuthFailureKind = "auth" | "forbidden";

/**
 * 401 and 403 are not the same problem and must not get the same advice.
 *
 * A 401 means no credential was accepted: the fix is to obtain one. A 403 means the credential
 * *was* accepted and this identity is still not permitted: obtaining another one changes nothing.
 * Telling somebody to run `login` after a 403 sends them round a loop they have already been
 * round, which is what happened the first time this ran against a real gated server. The identity
 * was fine; the URL named an organization the account did not belong to.
 *
 * Anything that is authorization-shaped but not specifically a refusal of an accepted identity is
 * reported as "auth", because the actionable advice there is the same as for a 401.
 */
export function authFailureKind(error: unknown): AuthFailureKind | undefined {
  if (!isAuthFailure(error)) return undefined;
  const text = `${error instanceof Error ? error.message : String(error)}`.toLowerCase();
  const cause = error instanceof UnreachableServerError && error.cause instanceof Error ? error.cause.message.toLowerCase() : "";
  const both = `${text} ${cause}`;
  // A 403 anywhere in the chain wins: it is the more specific of the two, and the only one whose
  // remediation differs. `InsufficientScopeError` is the same shape, arriving as a named error.
  const scoped = [error, error instanceof UnreachableServerError ? error.cause : undefined].some(
    (candidate) => candidate instanceof Error && candidate.name === "InsufficientScopeError",
  );
  if (scoped || /\b403\b|forbidden|insufficient[_ ]scope/.test(both)) return "forbidden";
  return "auth";
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

  /*
   * The cause's message counts too. A transport that wraps "403 Forbidden" in its own sentence
   * was being read as an outage, because only the outer message was ever examined.
   */
  const outer = `${error instanceof Error ? error.message : String(error)}`;
  const inner = error instanceof UnreachableServerError && error.cause instanceof Error ? error.cause.message : "";
  /*
   * Cut to a length no real error message reaches, and the gap bounded: `invalid or missing.*token`
   * scanned from every "invalid or missing" to the end of the text, so a server answering with
   * that phrase repeated across a megabyte held the audit for two minutes after it had answered.
   */
  const text = `${outer.slice(0, 4096)} ${inner.slice(0, 4096)}`.toLowerCase();
  return /\b(401|403)\b|unauthorized|forbidden|invalid or missing[^\n]{0,80}?token|authentication required|invalid_client|dynamic client registration/.test(text);
}
