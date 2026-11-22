/**
 * `check --comment` on a run with nothing to report, after one that had something.
 *
 * A clean run posted nothing, which is right for a pull request that never had findings, and left
 * the comment from the last run that did: "3 changes to what your agents can reach, 1 high" stayed
 * on a pull request whose surface now matched the lock. Found in an audit.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/commands/check";
import { runInit } from "../src/commands/init";
import { EXIT_CLEAN } from "../src/lib/exit";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const MARKER = "<!-- nulladrift:surface -->";
const TIMEOUT_MS = 20_000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Write {
  method: string;
  path: string;
  body: string;
}

async function github(comments: Array<{ id: number; body: string; user: { login: string } }>): Promise<{ api: string; writes: Write[] }> {
  const writes: Write[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const json = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (request.url === "/user") return json(403, {});
      if (request.method === "GET") return json(200, comments);
      writes.push({ method: request.method ?? "", path: request.url ?? "", body: (JSON.parse(body) as { body: string }).body });
      return json(200, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, writes };
}

async function cleanCheck(api: string): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-resolved-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: "base" } } } }),
    "utf8",
  );
  const env = { HOME: join(root, "no-home"), GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/web", GITHUB_REF: "refs/pull/7/merge", GITHUB_API_URL: api };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const writes = [process.stdout, process.stderr].map((stream) => stream.write.bind(stream));
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const options = { projectRoot: root, lockPath: join(root, "mcp.lock"), configFiles: [], timeoutMs: TIMEOUT_MS, allowUnreachable: false, format: "human" as const };
    await runInit(options);
    return await runCheck({ ...options, comment: true });
  } finally {
    process.stdout.write = writes[0]!;
    process.stderr.write = writes[1]!;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("a clean run with --comment", () => {
  it(
    "replaces the findings an earlier run posted, saying they are resolved",
    async () => {
      const { api, writes } = await github([{ id: 41, body: `${MARKER}\n### 3 changes to what your agents can reach, 1 high`, user: { login: "github-actions[bot]" } }]);
      expect(await cleanCheck(api)).toBe(EXIT_CLEAN);
      expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual(["PATCH /repos/acme/web/issues/comments/41"]);
      expect(writes[0]?.body.startsWith(MARKER)).toBe(true);
      expect(writes[0]?.body).toContain("matches the lock");
      expect(writes[0]?.body).not.toContain("3 changes");
    },
    TIMEOUT_MS * 2,
  );

  it(
    "posts nothing on a pull request that never had a comment",
    async () => {
      const { api, writes } = await github([]);
      expect(await cleanCheck(api)).toBe(EXIT_CLEAN);
      expect(writes).toEqual([]);
    },
    TIMEOUT_MS * 2,
  );
});
