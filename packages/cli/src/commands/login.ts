/**
 * `nulladrift login <server>` -- the one interactive step.
 *
 * A quarter of public MCP servers refuse an anonymous client, and the tool list a server shows
 * may depend on who is asking, so auditing them without credentials would pin the wrong surface
 * rather than a smaller one. This runs the authorization-code flow once and stores the result;
 * `check` refreshes it silently from then on and never opens a browser itself.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { auth } from "@modelcontextprotocol/client";
import { discoverServers, portablePath } from "../config/discover";
import type { ConfiguredServer } from "../config/types";
import { EXIT_CLEAN, EXIT_INCOMPLETE, type ExitCode } from "../lib/exit";
import { bold, dim, green, red } from "../lib/ui";
import { sanitizeUrl } from "../lock/normalize";
import { credentialPath, DEFAULT_CALLBACK_PATH, FileTokenProvider } from "../mcp/oauth";
import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

interface CallbackResult {
  code: string;
  state?: string;
  iss?: string;
}

/** A loopback listener on an ephemeral port. Nothing is bound to a public interface. */
async function awaitCallback(expectedState: string): Promise<{ redirectUrl: string; wait: () => Promise<CallbackResult>; close: () => void }> {
  let settle: ((result: CallbackResult) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== DEFAULT_CALLBACK_PATH) {
      response.writeHead(404).end("not found");
      return;
    }

    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error !== null) {
      response.writeHead(400, { "content-type": "text/plain" }).end(`authorization failed: ${error}`);
      fail?.(new Error(`${error}${url.searchParams.get("error_description") ? `: ${url.searchParams.get("error_description")}` : ""}`));
      return;
    }
    if (code === null) {
      response.writeHead(400, { "content-type": "text/plain" }).end("no authorization code in the callback");
      fail?.(new Error("callback carried no authorization code"));
      return;
    }
    /*
     * The state check is the CSRF defence for this flow: without it, anyone who can reach the
     * loopback port could feed us an authorization code minted for a different session.
     */
    if (state !== expectedState) {
      response.writeHead(400, { "content-type": "text/plain" }).end("state mismatch");
      fail?.(new Error("state parameter did not match; the login was not completed"));
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>nulladrift</title><p>Authorized. You can close this tab.");
    settle?.({ code, state, iss: url.searchParams.get("iss") ?? undefined });
  });

  await new Promise<void>((ready, broke) => {
    server.once("error", broke);
    server.listen(0, "127.0.0.1", ready);
  });
  const { port } = server.address() as AddressInfo;

  const received = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
    setTimeout(() => reject(new Error(`no callback within ${CALLBACK_TIMEOUT_MS / 1000}s`)), CALLBACK_TIMEOUT_MS).unref();
  });

  return {
    redirectUrl: `http://127.0.0.1:${port}${DEFAULT_CALLBACK_PATH}`,
    wait: () => received,
    close: () => server.close(),
  };
}

async function findServer(projectRoot: string, configFiles: string[], name: string): Promise<ConfiguredServer | { error: string }> {
  // Every config, the user's own included: login stores a token for this person and writes no lock.
  const discovery = await discoverServers(projectRoot, configFiles, { userConfigs: true });

  /*
   * A name defined differently in two files is two servers, and a token is a credential for one
   * of them. Project files are read first, so a cloned repository that defined `linear` sent the
   * person's login, and the token it stored, to the repository's server instead of their own.
   * A file named with --config says which is meant; otherwise nothing is guessed.
   */
  const conflict = discovery.conflicts.find((candidate) => candidate.name === name);
  if (conflict) {
    const named = new Set(configFiles.map((file) => portablePath(resolve(projectRoot, file), projectRoot)));
    const chosen = conflict.definitions.filter((definition) => named.has(definition.file));
    if (chosen.length === 1) return chosen[0]!.server;
    const where = conflict.definitions.map((definition) => `  ${definition.file}: ${describeTarget(definition.server)}`).join("\n");
    return { error: `"${name}" is defined differently in more than one config:\n${where}\nName the one you mean with --config <file>.` };
  }

  const server = discovery.servers.find((candidate) => candidate.name === name);
  if (!server) {
    const known = discovery.servers.map((candidate) => candidate.name);
    return { error: known.length === 0 ? "no MCP servers found in this project" : `no server named "${name}". Known: ${known.join(", ")}` };
  }
  if (server.transport.type === "stdio") return { error: `"${name}" is a stdio server; it is launched locally and has nothing to log in to` };
  return server;
}

/** Where a definition points, without anything in the URL that could be a key. */
function describeTarget(server: ConfiguredServer): string {
  const { transport } = server;
  return transport.type === "stdio" ? `runs ${transport.command}` : sanitizeUrl(transport.url);
}

export async function runLogin(options: { projectRoot: string; configFiles: string[]; serverName: string | undefined }): Promise<ExitCode> {
  if (options.serverName === undefined) {
    process.stderr.write(`${red("which server?")} ${dim("Usage: nulladrift login <server>")}\n`);
    return EXIT_INCOMPLETE;
  }

  const found = await findServer(options.projectRoot, options.configFiles, options.serverName);
  if ("error" in found) {
    process.stderr.write(`${red(found.error)}\n`);
    return EXIT_INCOMPLETE;
  }
  const serverUrl = found.transport.type === "stdio" ? "" : found.transport.url;

  const provider = new FileTokenProvider(found.name, serverUrl, { interactive: true });
  const callback = await awaitCallback(provider.stateValue);
  const authenticating = new FileTokenProvider(found.name, serverUrl, { interactive: true, redirectUrl: callback.redirectUrl });
  Object.assign(authenticating, { stateValue: provider.stateValue });

  try {
    // Without its query or userinfo: a URL that carries a key would otherwise print it.
    process.stdout.write(`${bold(`Authorizing ${found.name}`)}\n${dim(sanitizeUrl(serverUrl))}\n`);

    const started = await auth(authenticating, { serverUrl });
    if (started === "AUTHORIZED") {
      process.stdout.write(`${green("✓ already authorized")}\n`);
      return EXIT_CLEAN;
    }

    const { code, iss } = await callback.wait();
    const finished = await auth(authenticating, { serverUrl, authorizationCode: code, ...(iss === undefined ? {} : { iss }) });
    if (finished !== "AUTHORIZED") {
      process.stderr.write(`${red("authorization did not complete")}\n`);
      return EXIT_INCOMPLETE;
    }

    process.stdout.write(`${green(`✓ authorized ${found.name}`)}\n${dim(`tokens stored in ${credentialPath(serverUrl)} (owner-only)`)}\n`);
    return EXIT_CLEAN;
  } catch (error) {
    process.stderr.write(`${red("login failed:")} ${(error as Error).message}\n`);
    return EXIT_INCOMPLETE;
  } finally {
    callback.close();
  }
}

export async function runLogout(options: { projectRoot: string; configFiles: string[]; serverName: string | undefined }): Promise<ExitCode> {
  if (options.serverName === undefined) {
    process.stderr.write(`${red("which server?")} ${dim("Usage: nulladrift logout <server>")}\n`);
    return EXIT_INCOMPLETE;
  }
  const found = await findServer(options.projectRoot, options.configFiles, options.serverName);
  if ("error" in found) {
    process.stderr.write(`${red(found.error)}\n`);
    return EXIT_INCOMPLETE;
  }
  const url = found.transport.type === "stdio" ? "" : found.transport.url;
  const path = credentialPath(url);
  // Said either way, and for which server: "deleted" when nothing was there left a token behind
  // for somebody who believed they had removed it.
  const existed = await stat(path).then(
    () => true,
    () => false,
  );
  await rm(path, { force: true });
  process.stdout.write(
    `${dim(existed ? `stored credentials for ${found.name} (${sanitizeUrl(url)}) deleted` : `no credentials were stored for ${found.name} (${sanitizeUrl(url)})`)}\n`,
  );
  return EXIT_CLEAN;
}
