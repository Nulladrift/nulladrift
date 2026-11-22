/**
 * What a failure reason may quote of the values used to reach the server.
 *
 * Only environment values, header values and an OAuth client secret were taken out. A key handed
 * over in the arguments (`--api-key ${MY_KEY}`) or in the address (a path segment, the query, the
 * userinfo) came back in the server's stderr or the error text, and from there went to the
 * terminal, `check --json`, the pull request comment and the reading `push` sends. Found in an
 * audit.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureAll } from "../src/audit";
import { runCheck } from "../src/commands/check";

const TIMEOUT_MS = 10_000;
const ARG_KEY = "argkey-0123456789abcdef";
const PATH_KEY = "pathkey-0123456789abcdef";
const QUERY_KEY = "querykey-0123456789abcdef";
const LITERAL = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function workspace(servers: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-secrets-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
  return root;
}

async function withEnv<T>(root: string, values: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys({ ...values, HOME: "" }).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values, { HOME: join(root, "no-home") });
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Answers every request with a 404 that quotes the request line, as a default handler does. */
async function echoing(): Promise<string> {
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => response.writeHead(404, { "content-type": "text/plain" }).end(`Cannot ${request.method} ${request.url}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stdio server that rejects its key and quotes it, and every argument it was given, on the way out. */
const quoting = (args: string[]) => ({
  command: process.execPath,
  // Concatenated, not a template literal: `${` in a config is a placeholder.
  args: ["-e", 'process.stderr.write("Error: invalid credentials " + process.argv.slice(1).join(" ") + "\\n"); process.exit(1);', "--", ...args],
});

describe("a failure reason", () => {
  it("leaves out a key the config put in a server's arguments, written as a placeholder or literally", async () => {
    const root = await workspace({ leaky: quoting(["--api-key", "${LEAKY_API_KEY}", "--token", LITERAL, `--other=${"${LEAKY_OTHER}"}`]) });
    const { unreachable } = await withEnv(root, { LEAKY_API_KEY: ARG_KEY, LEAKY_OTHER: "other-0123456789abcdef" }, () => captureAll({ projectRoot: root, timeoutMs: TIMEOUT_MS }));

    const reason = unreachable[0]?.reason ?? "";
    expect(reason).toContain("invalid credentials");
    expect(reason).not.toContain(ARG_KEY);
    expect(reason).not.toContain(LITERAL);
    expect(reason).not.toContain("other-0123456789abcdef");
    expect(reason).toContain("[redacted]");
  });

  it("leaves out a key in the address: a path segment, the query, the userinfo", async () => {
    const host = await echoing();
    const root = await workspace({
      remote: { type: "http", url: `http://${host}/mcp/\${LEAKY_PATH_KEY}/stream?api_key=\${LEAKY_QUERY_KEY}&session=literal-session-0123456789` },
      userinfo: { type: "http", url: `http://alice:literal-passw0rd-0123@${host}/mcp` },
    });
    const { unreachable } = await withEnv(root, { LEAKY_PATH_KEY: PATH_KEY, LEAKY_QUERY_KEY: QUERY_KEY }, () => captureAll({ projectRoot: root, timeoutMs: TIMEOUT_MS }));

    const reasons = unreachable.map((failure) => failure.reason).join("\n");
    expect(reasons).toContain("Cannot POST");
    for (const secret of [PATH_KEY, QUERY_KEY, "literal-session-0123456789", "literal-passw0rd-0123"]) expect(reasons).not.toContain(secret);
    // The parts that say where it went stay, so the failure can still be acted on.
    expect(reasons).toContain("/mcp/");
  });

  it("is what `check --json` prints", async () => {
    const root = await workspace({ leaky: quoting(["--api-key", "${LEAKY_API_KEY}"]) });
    await writeFile(join(root, "mcp.lock"), JSON.stringify({ lockfileVersion: 2, subjects: {} }), "utf8");
    let output = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => ((output += chunk), true)) as typeof process.stdout.write;
    try {
      await withEnv(root, { LEAKY_API_KEY: ARG_KEY }, () =>
        runCheck({ projectRoot: root, lockPath: join(root, "mcp.lock"), configFiles: [], timeoutMs: TIMEOUT_MS, allowUnreachable: true, format: "json" }),
      );
    } finally {
      process.stdout.write = write;
    }
    expect(output).toContain("invalid credentials");
    expect(output).not.toContain(ARG_KEY);
  });
});
