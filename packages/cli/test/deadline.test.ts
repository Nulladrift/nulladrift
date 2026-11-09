/**
 * One deadline per server, which ends the conversation with it.
 *
 * A server answering every page just inside the request timeout, with another page always to
 * come, held a run for as long as 64 pages took: twenty minutes at the crawl's settings. The
 * deadline has to stop the run waiting, and also stop the listing it was waiting on.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfiguredServer } from "../src/config/types";
import { captureSurface } from "../src/mcp/capture";

const PROTOCOL = "2026-07-28";
const PAGE_DELAY_MS = 150;

let server: Server;
let url = "";
let pagesServed = 0;

beforeAll(async () => {
  const reply = (id: unknown, result: object) => ({
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": { name: "slow", version: "1.0.0" } } },
  });
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
      if (message.id === undefined) return void response.writeHead(202).end();
      const send = (out: object) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      if (message.method === "server/discover") {
        return send(reply(message.id, { supportedVersions: [PROTOCOL], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private" }));
      }
      if (message.method === "tools/list") {
        pagesServed += 1;
        const page = pagesServed;
        // Always inside the request timeout, and always another page.
        return void setTimeout(
          () => send(reply(message.id, { tools: [{ name: `tool_${page}`, inputSchema: { type: "object" } }], nextCursor: `page-${page}`, ttlMs: 0, cacheScope: "private" })),
          PAGE_DELAY_MS,
        );
      }
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("a server that never finishes listing", () => {
  it("is given up on at the deadline, and is asked for nothing more", async () => {
    const config: ConfiguredServer = { name: "slow", source: { client: "claude-code", file: ".mcp.json" }, transport: { type: "http", url, headers: {} } };
    const timeoutMs = 1_000;

    const started = Date.now();
    await expect(captureSurface(config, timeoutMs)).rejects.toThrow(/did not finish within 1000ms/);
    expect(Date.now() - started).toBeLessThan(timeoutMs + 500);

    // The listing behind the deadline stops too: at most the page already in flight arrives.
    const atDeadline = pagesServed;
    await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS * 5));
    expect(pagesServed - atDeadline).toBeLessThanOrEqual(1);
  });
});
