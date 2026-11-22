/** Transport selection. The SSE path is deprecated in the spec but still configured in the wild. */
import { SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { ConfiguredServer } from "../src/config/types";
import { buildTransport, connect, diagnosticLines } from "../src/mcp/connect";

const server = (transport: ConfiguredServer["transport"]): ConfiguredServer => ({
  name: "s",
  source: { client: "manual", file: "test" },
  transport,
});

describe("buildTransport", () => {
  it("uses the SSE transport for an SSE config", () => {
    /*
     * Not Streamable HTTP. An SSE server answered over the wrong transport fails in a way that
     * reads as "the server is down", sending people to debug a healthy service.
     */
    const transport = buildTransport(server({ type: "sse", url: "https://example.com/sse", headers: {} }));
    expect(transport).toBeInstanceOf(SSEClientTransport);
  });

  it("uses Streamable HTTP for an http config", () => {
    expect(buildTransport(server({ type: "http", url: "https://example.com/mcp", headers: {} }))).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("spawns a child process for a stdio config", () => {
    const transport = buildTransport(server({ type: "stdio", command: process.execPath, args: ["-e", ""], env: {} }));
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });
});

/*
 * The stderr shown when a stdio server dies used to be `slice(-3)`: the last three lines. A Node
 * process that fails on startup ends with a closing brace, a blank line and its version banner,
 * so the tail was reliably the least useful thing it printed. Against a real server whose entry
 * point had not been built, the report showed "}" and "Node.js v26.7.0" and dropped the line that
 * explained it.
 */
describe("diagnosticLines", () => {
  const nodeCrash = [
    "node:internal/modules/cjs/loader:1573",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module '/repo/mcp/dist/index.js'",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1569:15)",
    "    at wrapResolveFilename (node:internal/modules/cjs/loader:1123:27)",
    "  code: 'MODULE_NOT_FOUND',",
    "}",
    "",
    "Node.js v26.7.0",
  ].join("\n");

  it("keeps the line that names the failure", () => {
    expect(diagnosticLines(nodeCrash)[0]).toContain("Cannot find module");
  });

  it("drops the furniture that used to be all you saw", () => {
    const shown = diagnosticLines(nodeCrash).join("\n");
    expect(shown).not.toContain("Node.js v26.7.0");
    expect(shown).not.toMatch(/^\s*\}$/m);
    expect(shown).not.toContain("at Module._resolveFilename");
  });

  it("falls back to the first lines when nothing names a failure", () => {
    const chatty = "starting up\nlistening on stdio\nready\ngoodbye";
    expect(diagnosticLines(chatty)).toEqual(["starting up", "listening on stdio", "ready"]);
  });

  it("returns nothing for empty stderr", () => {
    expect(diagnosticLines("")).toEqual([]);
    expect(diagnosticLines("\n\n  \n")).toEqual([]);
  });
});

/*
 * A config that sets its own User-Agent was meant to keep it: some servers key on it. Written as
 * `User-Agent`, it sat beside the default `user-agent` as a second header, and the server received
 * the two joined -- "nulladrift/0.10.0 (...), Custom/1.0" -- which is neither. Found in an audit.
 */
describe("the User-Agent a server receives", () => {
  async function received(headers: Record<string, string>): Promise<string[]> {
    const seen: string[] = [];
    const listener = createServer((request, response) => {
      seen.push(String(request.headers["user-agent"]));
      request.resume();
      request.on("end", () => response.writeHead(404).end());
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
      await connect(server({ type: "http", url, headers }), 5_000).catch(() => undefined);
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
    return seen;
  }

  it("is the config's own, whatever case the config writes it in", async () => {
    for (const name of ["User-Agent", "user-agent", "USER-AGENT"]) {
      const seen = await received({ [name]: "Custom/1.0" });
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set(["Custom/1.0"]));
    }
  });

  it("is nulladrift's when the config sets none", async () => {
    const seen = await received({});
    expect(seen.length).toBeGreaterThan(0);
    for (const agent of seen) expect(agent).toMatch(/^nulladrift\//);
  });
});
