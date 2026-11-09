/**
 * OAuth for remote servers.
 *
 * About a quarter of the public registry refuses an anonymous client, and the specification
 * lets `tools/list` vary with the authorization presented -- so an unauthenticated audit of
 * those servers is not a smaller audit, it is an audit of a different surface. Two flows are
 * supported, for the two places this runs:
 *
 *  - **Client credentials**, from `oauth.clientId` / `oauth.clientSecret` in the client config.
 *    Non-interactive, so it works in CI. The SDK's own provider handles it.
 *  - **Authorization code with PKCE**, through `nulladrift login <server>`, which opens a browser
 *    once and stores the resulting tokens. `check` then refreshes them silently.
 *
 * `check` never starts a browser. A run that needs authorization fails with an instruction
 * instead: an audit that blocks on a human is an audit that hangs a CI job.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { ClientCredentialsProvider, UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { ConfiguredOAuth, ConfiguredServer } from "../config/types";
import { VERSION } from "../lib/version";

export const DEFAULT_CALLBACK_PATH = "/callback";

export function authDir(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "nulladrift", "auth");
}

/**
 * Keyed by the server's URL, not its configured name. Two projects that call the same endpoint
 * different things should share one grant, and one name pointed at a new endpoint must not
 * silently reuse the old endpoint's token.
 */
export function credentialPath(url: string): string {
  return join(authDir(), `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.json`);
}

interface StoredCredentials {
  serverUrl: string;
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  authorizationServerUrl?: string;
  resourceUrl?: string;
  discoveryState?: OAuthDiscoveryState;
}

export class InteractiveAuthRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(`authorization required. Run \`nulladrift login ${serverName}\` once, then re-run.`);
    this.name = "InteractiveAuthRequiredError";
  }
}

/**
 * An `OAuthClientProvider` that keeps its state in a file.
 *
 * In `interactive: false` -- every mode except `login` -- `redirectToAuthorization` throws
 * rather than opening anything, which turns "this needs a human" into a message instead of a
 * hung process.
 */
export class FileTokenProvider implements OAuthClientProvider {
  private cache: StoredCredentials | undefined;
  /** One per login attempt, held in memory and checked against what comes back on the callback. */
  readonly stateValue = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32);

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly options: { interactive: boolean; redirectUrl?: string; scope?: string } = { interactive: false },
  ) {}

  get redirectUrl(): string | undefined {
    return this.options.redirectUrl;
  }

  state(): string {
    return this.stateValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `nulladrift ${VERSION}`,
      // A command-line tool is a native client: it cannot keep a secret in a shipped binary.
      application_type: "native",
      redirect_uris: this.options.redirectUrl === undefined ? [] : [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.options.scope === undefined ? {} : { scope: this.options.scope }),
    } as OAuthClientMetadata;
  }

  private async read(): Promise<StoredCredentials> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(credentialPath(this.serverUrl), "utf8")) as StoredCredentials;
    } catch {
      this.cache = { serverUrl: this.serverUrl };
    }
    return this.cache;
  }

  private async write(patch: Partial<StoredCredentials>): Promise<void> {
    const next = { ...(await this.read()), ...patch, serverUrl: this.serverUrl };
    this.cache = next;
    const path = credentialPath(this.serverUrl);
    // Tokens are bearer credentials: the directory and the file are owner-only.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    return (await this.read()).clientInformation;
  }
  async saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
    await this.write({ clientInformation });
  }
  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.read()).tokens;
  }
  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.write({ tokens });
  }
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.write({ codeVerifier });
  }
  async codeVerifier(): Promise<string> {
    const stored = (await this.read()).codeVerifier;
    if (stored === undefined) throw new Error("no PKCE verifier stored; start the login again");
    return stored;
  }
  async saveAuthorizationServerUrl(authorizationServerUrl: string): Promise<void> {
    await this.write({ authorizationServerUrl });
  }
  async authorizationServerUrl(): Promise<string | undefined> {
    return (await this.read()).authorizationServerUrl;
  }
  async saveResourceUrl(resourceUrl: string): Promise<void> {
    await this.write({ resourceUrl });
  }
  async resourceUrl(): Promise<string | undefined> {
    return (await this.read()).resourceUrl;
  }
  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.write({ discoveryState });
  }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") {
      this.cache = { serverUrl: this.serverUrl };
      await rm(credentialPath(this.serverUrl), { force: true });
      return;
    }
    const key = { client: "clientInformation", tokens: "tokens", verifier: "codeVerifier", discovery: "discoveryState" }[scope];
    await this.write({ [key]: undefined } as Partial<StoredCredentials>);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.interactive) throw new InteractiveAuthRequiredError(this.serverName);
    if (openInBrowser(authorizationUrl)) {
      process.stderr.write(`\nIf a browser did not open, visit:\n  ${authorizationUrl.toString()}\n\n`);
    } else {
      process.stderr.write(`\nNot opening ${authorizationUrl.protocol} address the server named; an authorization page has to be https. Address:\n  ${authorizationUrl.toString()}\n\n`);
    }
  }
}

/**
 * Opens an authorization page, if it is one.
 *
 * The address comes from the authorization server's metadata, which the MCP server chose, so it
 * is untrusted input. Only `https:` is opened (and `http:` on loopback, for a local server), so a
 * server cannot hand the browser a `file:`, `smb:` or custom-scheme link. On Windows it is not
 * passed through `cmd /c start`: cmd reads `&` and `|` in a URL as command separators, and a
 * URL's query is full of `&`, so a server could run a command and every real login URL was cut
 * at its first parameter. `rundll32 url.dll,FileProtocolHandler` takes the URL as one argument.
 *
 * Returns whether it tried to open it; the caller prints the address either way.
 */
export function openInBrowser(url: URL): boolean {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return false;
  const target = url.toString();
  const [command, args] =
    platform() === "darwin"
      ? ["open", [target]]
      : platform() === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // The URL is printed either way; failing to launch a browser is not fatal.
  }
  return true;
}

/**
 * True when a previous `login` left a usable **token** for this endpoint.
 *
 * Deliberately not a file-existence check. A login that failed part-way still writes the file
 * -- it holds the PKCE verifier and discovery state so a retry can resume -- and treating that
 * as credentials made one failed attempt permanently re-enable the registration path it was
 * supposed to avoid. Only an access token counts.
 */
export function hasStoredCredentials(url: string): boolean {
  try {
    const stored = JSON.parse(readFileSync(credentialPath(url), "utf8")) as StoredCredentials;
    return typeof stored.tokens?.access_token === "string" && stored.tokens.access_token.length > 0;
  } catch {
    return false;
  }
}

/**
 * The provider a connection should use, if any. Client credentials win: they are explicit
 * configuration, they work unattended, and they do not depend on a prior `login`.
 *
 * Offering a provider with nothing behind it is worse than offering none. The SDK responds to a
 * 401 by attempting Dynamic Client Registration, and a non-interactive run has no redirect URI
 * to register -- so the server rejects the registration and the audit reports
 * `invalid_client_metadata` instead of "this one needs credentials". Returning undefined lets
 * the plain 401 through, which is the honest signal.
 */
export function createAuthProvider(server: ConfiguredServer, options: { interactive?: boolean } = {}): OAuthClientProvider | undefined {
  if (server.transport.type === "stdio") return undefined;
  const oauth: ConfiguredOAuth | undefined = server.transport.oauth;

  if (oauth?.clientId !== undefined && oauth.clientSecret !== undefined) {
    return new ClientCredentialsProvider({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      // The SDK then refuses to send the secret to any other authorization server (SEP-2352).
      ...(oauth.issuer === undefined ? {} : { expectedIssuer: oauth.issuer }),
      clientName: `nulladrift ${VERSION}`,
      ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
    });
  }

  const interactive = options.interactive ?? false;
  if (!interactive && !hasStoredCredentials(server.transport.url)) return undefined;

  return new FileTokenProvider(server.name, server.transport.url, {
    interactive,
    ...(oauth?.scope === undefined ? {} : { scope: oauth.scope }),
  });
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedError || error instanceof InteractiveAuthRequiredError;
}
