/**
 * Authorization. A server that refuses an anonymous client is not a smaller audit -- the spec
 * lets the tool list vary with the credentials presented, so an unauthenticated capture of a
 * gated server pins a surface nobody uses.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientCredentialsProvider } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfiguredServer } from "../src/config/types";
import { parseServerMap } from "../src/config/parsers";
import { authFailureKind, isAuthFailure, UnreachableServerError } from "../src/mcp/types";
import { createAuthProvider, credentialPath, FileTokenProvider, hasStoredCredentials, InteractiveAuthRequiredError, openInBrowser } from "../src/mcp/oauth";

let configHome: string;
let previous: string | undefined;

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "mcp-auth-"));
  previous = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = configHome;
});

afterEach(async () => {
  if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previous;
  await rm(configHome, { recursive: true, force: true });
});

const remote = (oauth?: Record<string, string>): ConfiguredServer => ({
  name: "gated",
  source: { client: "manual", file: "test" },
  transport: { type: "http", url: "https://api.example.com/mcp", headers: {}, ...(oauth ? { oauth } : {}) },
});

describe("choosing a provider", () => {
  it("prefers client credentials, which need no human and work in CI", () => {
    const provider = createAuthProvider(remote({ clientId: "id", clientSecret: "secret" }));
    expect(provider).toBeInstanceOf(ClientCredentialsProvider);
  });

  it("offers nothing non-interactively when no login has happened", async () => {
    /*
     * Regression: offering an empty provider made the SDK answer a 401 by attempting Dynamic
     * Client Registration, which a non-interactive run cannot complete (no redirect URI). The
     * audit then reported `invalid_client_metadata` instead of "this one needs credentials".
     */
    expect(createAuthProvider(remote())).toBeUndefined();
  });

  it("uses stored tokens from a previous login", async () => {
    const provider = new FileTokenProvider("gated", "https://api.example.com/mcp");
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" } as never);
    expect(createAuthProvider(remote())).toBeInstanceOf(FileTokenProvider);
  });

  it("always offers one for an interactive login, which is about to create the credentials", () => {
    expect(createAuthProvider(remote(), { interactive: true })).toBeInstanceOf(FileTokenProvider);
  });

  it("offers nothing for a stdio server, which is launched locally", () => {
    const stdio: ConfiguredServer = {
      name: "local",
      source: { client: "manual", file: "test" },
      transport: { type: "stdio", command: "node", args: [], env: {} },
    };
    expect(createAuthProvider(stdio)).toBeUndefined();
  });
});

describe("credential storage", () => {
  it("is keyed by the server URL, not the name it was given", () => {
    // Two projects naming the same endpoint differently share one grant; one name repointed at
    // a new endpoint must not reuse the old endpoint's token.
    expect(credentialPath("https://a.example/mcp")).toBe(credentialPath("https://a.example/mcp"));
    expect(credentialPath("https://a.example/mcp")).not.toBe(credentialPath("https://b.example/mcp"));
  });

  it("writes tokens owner-only and reads them back", async () => {
    const provider = new FileTokenProvider("gated", "https://api.example.com/mcp");
    await provider.saveTokens({ access_token: "at", token_type: "Bearer", refresh_token: "rt" } as never);

    const path = credentialPath("https://api.example.com/mcp");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const reloaded = new FileTokenProvider("gated", "https://api.example.com/mcp");
    expect((await reloaded.tokens())?.access_token).toBe("at");
  });

  it("forgets everything on invalidate", async () => {
    const provider = new FileTokenProvider("gated", "https://api.example.com/mcp");
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" } as never);
    await provider.invalidateCredentials("all");
    expect(await provider.tokens()).toBeUndefined();
    await expect(readFile(credentialPath("https://api.example.com/mcp"), "utf8")).rejects.toThrow();
  });

  it("uses a fresh state value per instance", () => {
    const a = new FileTokenProvider("x", "https://api.example.com/mcp");
    const b = new FileTokenProvider("x", "https://api.example.com/mcp");
    expect(a.stateValue).not.toBe(b.stateValue);
    expect(a.state()).toBe(a.stateValue);
  });
});

describe("hasStoredCredentials", () => {
  it("wants a token, not merely a file", async () => {
    /*
     * A login that failed part-way still writes the file -- it holds the PKCE verifier so a
     * retry can resume. Counting that as credentials made one failed attempt permanently
     * re-enable the registration path this is meant to avoid.
     */
    const provider = new FileTokenProvider("gated", "https://api.example.com/mcp");
    await provider.saveCodeVerifier("half-finished-login");
    expect(await readFile(credentialPath("https://api.example.com/mcp"), "utf8")).toContain("half-finished-login");
    expect(hasStoredCredentials("https://api.example.com/mcp")).toBe(false);

    await provider.saveTokens({ access_token: "at", token_type: "Bearer" } as never);
    expect(hasStoredCredentials("https://api.example.com/mcp")).toBe(true);
  });

  it("is false for an endpoint nobody has logged into", () => {
    expect(hasStoredCredentials("https://never-seen.example.com/mcp")).toBe(false);
  });
});

describe("non-interactive runs", () => {
  it("refuses to open a browser and says what to do instead", async () => {
    // `check` runs in CI. Launching a browser there would hang the job.
    const provider = new FileTokenProvider("gated", "https://api.example.com/mcp", { interactive: false });
    await expect(provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"))).rejects.toThrow(InteractiveAuthRequiredError);
    await expect(provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"))).rejects.toThrow(/nulladrift login gated/);
  });

  it("is classified as an authorization problem, not an outage", () => {
    expect(isAuthFailure(new InteractiveAuthRequiredError("gated"))).toBe(true);
    expect(isAuthFailure(new UnreachableServerError("gated", "boom", new InteractiveAuthRequiredError("gated")))).toBe(true);
  });

  it("counts the shapes real servers actually return", () => {
    // Observed against public registry servers.
    const registrationRejected = Object.assign(new Error("Dynamic Client Registration rejected (HTTP 400)"), { name: "RegistrationRejectedError" });
    expect(isAuthFailure(registrationRejected)).toBe(true);
    expect(isAuthFailure(new UnreachableServerError("g", "Version negotiation failed: the server requires authorization (HTTP 401)"))).toBe(true);
    expect(isAuthFailure(new UnreachableServerError("g", 'Error POSTing to endpoint: {"error":{"code":-32001,"message":"Unauthorized"}}'))).toBe(true);
    // And still does not swallow a genuine outage.
    expect(isAuthFailure(new UnreachableServerError("g", "getaddrinfo ENOTFOUND api.example.com"))).toBe(false);
  });
});

describe("oauth in a client config", () => {
  it("reads clientId and clientSecret, expanding them from the environment", async () => {
    const parsed = await parseServerMap(
      { mcpServers: { gated: { type: "http", url: "https://api.example.com/mcp", oauth: { clientId: "cid", clientSecret: "${GATED_SECRET}", issuer: "https://auth.example.com", scopes: ["a", "b"] } } } },
      "mcpServers",
      { client: "claude-code", file: ".mcp.json" },
      { workspaceFolder: "/tmp", env: { GATED_SECRET: "from-env" } },
    );
    const transport = parsed.servers[0]?.transport;
    expect(transport?.type === "http" ? transport.oauth : undefined).toEqual({ clientId: "cid", clientSecret: "from-env", issuer: "https://auth.example.com", scope: "a b" });
  });

  it("skips the server when the secret is not in the environment, rather than auditing half a surface", async () => {
    const parsed = await parseServerMap(
      { mcpServers: { gated: { type: "http", url: "https://api.example.com/mcp", oauth: { clientId: "cid", clientSecret: "${MISSING_SECRET}", issuer: "https://auth.example.com" } } } },
      "mcpServers",
      { client: "claude-code", file: ".mcp.json" },
      { workspaceFolder: "/tmp", env: {} },
    );
    expect(parsed.servers).toHaveLength(0);
    expect(parsed.skipped[0]?.message).toContain("${MISSING_SECRET}");
  });

  /*
   * Without an issuer the secret goes to whichever authorization server the MCP server names in
   * its metadata, so a compromised server could name its own and collect it on the next CI run.
   */
  it("refuses a client secret that does not say which authorization server it is for", async () => {
    const parsed = await parseServerMap(
      { mcpServers: { gated: { type: "http", url: "https://api.example.com/mcp", oauth: { clientId: "cid", clientSecret: "${GATED_SECRET}" } } } },
      "mcpServers",
      { client: "claude-code", file: ".mcp.json" },
      { workspaceFolder: "/tmp", env: { GATED_SECRET: "from-env" } },
    );
    expect(parsed.servers).toHaveLength(0);
    expect(parsed.skipped[0]?.message).toMatch(/oauth\.issuer/);
    expect(parsed.skipped[0]?.message).not.toContain("from-env");
  });

  it("never lets a client secret reach the lockfile", async () => {
    const { lockTransport } = await import("../src/lock/build");
    const locked = lockTransport(remote({ clientId: "cid", clientSecret: "top-secret" }));
    expect(JSON.stringify(locked)).not.toContain("top-secret");
    expect(JSON.stringify(locked)).not.toContain("cid");
  });
});

/*
 * 401 and 403 reached this tool as the same thing, and the advice printed for both was "run
 * `nulladrift login`". Against Sentry's hosted server that was a loop: the login succeeded, the
 * credential was accepted, and the 403 stood, because the URL named an organization the account
 * was not a member of. These cases exist so the two never collapse back into one again.
 */
describe("authFailureKind separates a missing credential from a refused one", () => {
  it("calls an unauthenticated server 'auth'", () => {
    expect(authFailureKind(new UnreachableServerError("s", "Version negotiation failed: the server requires authorization (HTTP 401)"))).toBe("auth");
    expect(authFailureKind(new UnreachableServerError("s", "HTTP 401 Unauthorized"))).toBe("auth");
    expect(authFailureKind(new UnreachableServerError("s", "invalid or missing MCP token"))).toBe("auth");
  });

  it("calls an accepted-then-refused credential 'forbidden'", () => {
    // The exact string the Sentry run produced.
    expect(authFailureKind(new UnreachableServerError("sentry", "Version negotiation failed: the server denied access (HTTP 403)"))).toBe("forbidden");
    expect(authFailureKind(new UnreachableServerError("s", "HTTP 403 Forbidden"))).toBe("forbidden");
  });

  it("reads a 403 through the cause as well as the message", () => {
    expect(authFailureKind(new UnreachableServerError("s", "capture failed", new Error("403 Forbidden")))).toBe("forbidden");
  });

  it("leaves everything that is not an authorization outcome undefined", () => {
    expect(authFailureKind(new UnreachableServerError("s", "connect ECONNREFUSED"))).toBeUndefined();
    expect(authFailureKind(new UnreachableServerError("s", "spawn ENOENT"))).toBeUndefined();
  });

  it("still reports both as auth failures, so neither is mistaken for an outage", () => {
    expect(isAuthFailure(new UnreachableServerError("s", "HTTP 403 Forbidden"))).toBe(true);
    expect(isAuthFailure(new UnreachableServerError("s", "HTTP 401 Unauthorized"))).toBe(true);
  });
});

/*
 * The authorization page's address comes from metadata the MCP server chose. It was handed to the
 * platform opener as is: `cmd /c start` on Windows, where `&` in a URL runs a command, and
 * `open`/`xdg-open` elsewhere, which follow any scheme.
 */
describe("opening an authorization page", () => {
  it("refuses anything that is not an https page (or http on this machine), without launching anything", () => {
    for (const address of ["file:///etc/passwd", "smb://evil.example/share", "http://evil.example/authorize", "vscode://evil/run", "https://"]) {
      let url: URL | undefined;
      try {
        url = new URL(address);
      } catch {
        continue;
      }
      expect(openInBrowser(url), address).toBe(false);
    }
  });
});
