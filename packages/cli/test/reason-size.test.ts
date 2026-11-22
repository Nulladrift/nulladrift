/**
 * How much of a server's error text a reason carries.
 *
 * Nothing bounded it. A server answering 404 with a 5 MB body put all of it into the terminal, the
 * `--json` report and the reading `push` sends, and into the pull request comment, which GitHub
 * refuses past 65,536 characters -- so the findings were not posted at all. Found in an audit.
 */
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureAll } from "../src/audit";
import { upsertComment } from "../src/report/comment";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listen(handler: RequestListener): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("a failure reason", () => {
  it("keeps the start of a 5 MB error body and says how much it left out", async () => {
    const base = await listen((request, response) => {
      request.resume();
      request.on("end", () => response.writeHead(404, { "content-type": "text/plain" }).end(`Not Found. ${"A".repeat(5 * 1024 * 1024)}`));
    });
    const root = await mkdtemp(join(tmpdir(), "nulladrift-big-reason-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { big: { type: "http", url: `${base}/mcp` } } }), "utf8");

    const previous = process.env["HOME"];
    process.env["HOME"] = join(root, "no-home");
    try {
      const { unreachable } = await captureAll({ projectRoot: root, timeoutMs: 10_000 });
      const reason = unreachable[0]?.reason ?? "";
      expect(reason).toContain("Not Found.");
      expect(reason.length).toBeLessThanOrEqual(2_200);
      expect(reason).toMatch(/\(\d+ more characters\)/);
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
    }
  }, 20_000);
});

describe("the pull request comment", () => {
  it("is cut to what GitHub accepts, rather than refused whole", async () => {
    const posted: string[] = [];
    const api = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        if (request.url === "/user") return void response.writeHead(403).end();
        if (request.method === "GET") return void response.writeHead(200, { "content-type": "application/json" }).end("[]");
        const text = (JSON.parse(body) as { body: string }).body;
        posted.push(text);
        // GitHub's own limit.
        response.writeHead(text.length > 65_536 ? 422 : 201, { "content-type": "application/json" }).end("{}");
      });
    });

    const lines = Array.from({ length: 2_000 }, (_, index) => `| ${index} | ${"x".repeat(60)} |`).join("\n");
    expect(await upsertComment({ api, repo: "acme/web", issue: 7, token: "t" }, `### findings\n\n${lines}`)).toBe("created");
    expect(posted[0]!.length).toBeLessThanOrEqual(65_536);
    expect(posted[0]).toContain("### findings");
    expect(posted[0]).toContain("cut short");
  });
});
