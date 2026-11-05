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
import { discoverServers } from "../config/discover";
import type { ConfiguredServer } from "../config/types";
import { EXIT_CLEAN, EXIT_INCOMPLETE, type ExitCode } from "../lib/exit";
import { bold, dim, green, red } from "../lib/ui";
import { credentialPath, DEFAULT_CALLBACK_PATH, FileTokenProvider } from "../mcp/oauth";
import { rm } from "node:fs/promises";

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
  const discovery = await discoverServers(projectRoot, configFiles);
  const server = discovery.servers.find((candidate) => candidate.name === name);
  if (!server) {
    const known = discovery.servers.map((candidate) => candidate.name);
    return { error: known.length === 0 ? "no MCP servers found in this project" : `no server named "${name}". Known: ${known.join(", ")}` };
  }
  if (server.transport.type === "stdio") return { error: `"${name}" is a stdio server; it is launched locally and has nothing to log in to` };
  return server;
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
    process.stdout.write(`${bold(`Authorizing ${found.name}`)}\n${dim(serverUrl)}\n`);

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
  await rm(credentialPath(url), { force: true });
  process.stdout.write(`${dim(`stored credentials for ${found.name} deleted`)}\n`);
  return EXIT_CLEAN;
}
