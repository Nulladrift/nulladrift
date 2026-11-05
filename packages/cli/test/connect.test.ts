/** Transport selection. The SSE path is deprecated in the spec but still configured in the wild. */
import { SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import type { ConfiguredServer } from "../src/config/types";
import { buildTransport } from "../src/mcp/connect";

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
