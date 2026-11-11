/**
 * `push` on GitHub Actions, end to end: a real server captured over stdio, a stand-in for
 * GitHub's token endpoint and one for the control plane, on this machine.
 *
 * What matters is a property of the bytes on the wire. The reading token has to be minted for
 * the sha256 of exactly the body the control plane receives, and the build token still has to
 * arrive beside it for a control plane that knows nothing else.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runPush } from "../src/commands/push";
import { EXIT_CLEAN, EXIT_INCOMPLETE } from "../src/lib/exit";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));

interface Received {
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let origin = "";
const received: Received[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/token") {
        // GitHub's endpoint, answering with a "token" that just says what it was minted for.
        return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value: `minted-for:${url.searchParams.get("audience")}` }));
      }
      received.push({ body, headers: request.headers });
      const reading = request.headers["nulladrift-reading-token"];
      response.writeHead(201, { "content-type": "application/json" }).end(
        JSON.stringify({
          readingId: "0123456789abcdef",
          verdict: "clean",
          exitCode: 0,
          changes: [],
          decision: { blocked: false, reasons: [] },
          url: `${origin}/r/1`,
          identity: { trust: "trusted", repository: "acme/web", ref: "refs/heads/main", ...(reading ? { boundToReading: true } : {}) },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(async () => {
  received.length = 0;
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A project with one real stdio server, and GitHub Actions' environment, for the length of `run`. */
async function inActions<T>(env: Record<string, string | undefined>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-push-"));
  dirs.push(root);
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { wire: { command: process.execPath, args: [SERVER] } } }), "utf8");

  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const savedHome = process.env["HOME"];
  process.env["HOME"] = join(root, "home");
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run(root);
  } finally {
    process.env["HOME"] = savedHome;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ACTIONS = () => ({
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
  NULLADRIFT_ID_TOKEN: undefined,
  NULLADRIFT_BUILD_AUDIENCE: undefined,
});

const pushOptions = (root: string) => ({
  projectRoot: root,
  lockPath: join(root, "mcp.lock"),
  configFiles: [],
  timeoutMs: 20_000,
  allowUnreachable: false,
  format: "human" as const,
  apiUrl: origin,
  token: "ndft_test",
  project: "web",
  provenance: false,
});

const push = (root: string) =>
  runPush({
    projectRoot: root,
    lockPath: join(root, "mcp.lock"),
    configFiles: [],
    timeoutMs: 20_000,
    allowUnreachable: false,
    format: "human",
    apiUrl: origin,
    token: "ndft_test",
    project: "web",
    provenance: false,
  });

describe("push on GitHub Actions", () => {
  it("sends a token minted for the sha256 of exactly the bytes it sends, and the build token beside it", async () => {
    const code = await inActions(ACTIONS(), push);
    expect(code).toBe(EXIT_CLEAN);

    const [request] = received;
    const digest = createHash("sha256").update(request!.body).digest("hex");
    expect(request!.headers["nulladrift-reading-token"]).toBe(`minted-for:${origin}#sha256:${digest}`);
    expect(request!.headers["nulladrift-build-token"]).toBe("minted-for:nulladrift");
    expect(JSON.parse(request!.body)).toMatchObject({ project: "web", servers: [{ name: "wire" }] });
  });

  it("names a configured audience instead of the origin, for both tokens", async () => {
    await inActions({ ...ACTIONS(), NULLADRIFT_BUILD_AUDIENCE: "nulladrift-acme" }, push);
    const [request] = received;
    const digest = createHash("sha256").update(request!.body).digest("hex");
    expect(request!.headers["nulladrift-reading-token"]).toBe(`minted-for:nulladrift-acme#sha256:${digest}`);
    expect(request!.headers["nulladrift-build-token"]).toBe("minted-for:nulladrift-acme");
  });

  it("sends only the token it was given outside GitHub Actions", async () => {
    await inActions({ GITHUB_ACTIONS: undefined, ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined, NULLADRIFT_ID_TOKEN: "from-gitlab" }, push);
    const [request] = received;
    expect(request!.headers["nulladrift-build-token"]).toBe("from-gitlab");
    expect(request!.headers["nulladrift-reading-token"]).toBeUndefined();
  });
});

/*
 * Tokens that cannot be sent. Node refuses a header value with a line break in a message that
 * quotes the whole header, token and all, and push printed that message to the job log.
 */
describe("a token with a line break in it", () => {
  async function stderrOf(run: () => Promise<unknown>): Promise<{ result: unknown; text: string }> {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      return { result: await run(), text: written.join("") };
    } finally {
      spy.mockRestore();
    }
  }

  it("is refused by name, and the collector token is never printed", async () => {
    const { result, text } = await stderrOf(() =>
      inActions({ GITHUB_ACTIONS: undefined }, (root) => runPush({ ...pushOptions(root), token: "ndft_SECRET\nrest" })),
    );
    expect(result).toBe(EXIT_INCOMPLETE);
    expect(text).toContain("--token");
    expect(text).not.toContain("ndft_SECRET");
    expect(received).toHaveLength(0);
  });

  it("leaves out an identity token it cannot send, and still pushes", async () => {
    const { result, text } = await stderrOf(() =>
      inActions({ GITHUB_ACTIONS: undefined, ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined, NULLADRIFT_ID_TOKEN: "id-SECRET\nx" }, push),
    );
    expect(result).toBe(EXIT_CLEAN);
    expect(text).toContain("NULLADRIFT_ID_TOKEN");
    expect(text).not.toContain("id-SECRET");
    expect(received[0]!.headers["nulladrift-build-token"]).toBeUndefined();
  });

  it("says that --token is visible to other processes", async () => {
    const { text } = await stderrOf(() => inActions({ GITHUB_ACTIONS: undefined }, push));
    expect(text).toContain("prefer NULLADRIFT_TOKEN");
  });
});
