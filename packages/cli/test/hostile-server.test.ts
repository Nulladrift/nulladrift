/**
 * What a server under audit can do to the audit, found in a security review.
 *
 * A tool parameter named `__proto__` never reached the lock: the client library validates each
 * reply and drops that key in rebuilding it, so a server could change the text under it and
 * `check` passed. A server that sent enough ran the audit out of memory, which killed the
 * process with exit 134 rather than reporting the server. And a header value with a line break in
 * it made Node refuse the request in a message that quoted the whole value, secret included,
 * which went into the reason, the pull request comment and the reading.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { captureSurface } from "../src/mcp/capture";
import { UnreachableServerError } from "../src/mcp/types";
import { configured } from "./helpers";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));

const fixture = (variant: string) =>
  configured("hostile", { type: "stdio", command: process.execPath, args: [SERVER], env: { NULLADRIFT_FIXTURE_VARIANT: variant } });

async function refusal(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UnreachableServerError);
  return (error as Error).message;
}

describe("a reply the client library would rewrite", () => {
  it("refuses a surface with a key named __proto__ rather than pinning one without it", async () => {
    const reason = await refusal(captureSurface(fixture("proto"), 15_000));
    expect(reason).toContain("__proto__");
  });

  it("still captures the same server's ordinary surface", async () => {
    const surface = await captureSurface(fixture("base"), 15_000);
    expect(surface.tools.length).toBeGreaterThan(0);
  });
});

describe("a server that sends too much", () => {
  it("is stopped and reported, not allowed to run the audit out of memory", async () => {
    const reason = await refusal(captureSurface(fixture("flood"), 60_000));
    expect(reason).toMatch(/more than 32 MB/);
  }, 90_000);
});

describe("a value HTTP cannot carry", () => {
  const SECRET = "sk-live-PROBESECRET";

  it("is refused by naming the header, never by quoting the value", async () => {
    const server = configured("remote", { type: "http", url: "http://127.0.0.1:9/mcp", headers: { authorization: `Token acme\n:${SECRET}` } });
    const reason = await refusal(captureSurface(server, 5_000));
    expect(reason).toContain("authorization");
    expect(reason).not.toContain(SECRET);
    expect(reason).not.toContain("acme");
  });

  it("is refused for a NUL in a stdio server's environment, by name", async () => {
    const server = configured("local", { type: "stdio", command: process.execPath, args: [SERVER], env: { API_KEY: `${SECRET}\u0000x` } });
    const reason = await refusal(captureSurface(server, 5_000));
    expect(reason).toContain("API_KEY");
    expect(reason).not.toContain(SECRET);
  });
});
