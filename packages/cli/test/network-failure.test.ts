/**
 * Why a remote server could not be reached, in words somebody can act on.
 *
 * Found by using the product: a remote server that was not running was reported as "Version
 * negotiation probe failed: fetch failed", which does not say whether the URL, the network or the
 * server is wrong. Node keeps the real reason in `cause`, sometimes inside an AggregateError.
 */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { captureSurface } from "../src/mcp/capture";
import { describeNetworkFailure } from "../src/mcp/network";
import { UnreachableServerError } from "../src/mcp/types";
import { configured } from "./helpers";

/** A port that was just free and is now closed, so a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const wrapped = (inner: object) => Object.assign(new Error("Version negotiation probe failed: fetch failed"), { cause: Object.assign(new TypeError("fetch failed"), { cause: inner }) });

describe("describeNetworkFailure", () => {
  it("says a refused connection means nothing is listening, and where", () => {
    const text = describeNetworkFailure(wrapped({ code: "ECONNREFUSED", address: "127.0.0.1", port: 59999 }));
    expect(text).toMatch(/^connection refused by 127\.0\.0\.1:59999: nothing is listening there/);
  });

  it("finds the reason inside an AggregateError, as Node raises when it tried more than one address", () => {
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED ::1:59999"), { code: "ECONNREFUSED", address: "::1", port: 59999 })]), {});
    expect(describeNetworkFailure(wrapped(aggregate))).toContain("[::1]:59999");
  });

  it("names an unresolvable host and suggests a typo", () => {
    expect(describeNetworkFailure(wrapped({ code: "ENOTFOUND", hostname: "mcp.exmaple.com" }))).toMatch(/mcp\.exmaple\.com does not resolve/);
  });

  it("says a certificate was refused and what to do about a private CA", () => {
    expect(describeNetworkFailure(wrapped({ code: "SELF_SIGNED_CERT_IN_CHAIN" }))).toMatch(/TLS certificate was not accepted.*NODE_EXTRA_CA_CERTS/);
  });

  it("says nothing when the chain holds no network reason, so the original message stands", () => {
    expect(describeNetworkFailure(new Error("server answered 500"))).toBeUndefined();
    expect(describeNetworkFailure("not even an error")).toBeUndefined();
  });

  it("stops on a cause chain that loops", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(describeNetworkFailure(looped)).toBeUndefined();
  });
});

describe("a remote server that is not running", () => {
  it("is reported with the reason, not only 'fetch failed'", async () => {
    const port = await closedPort();
    const failure = await captureSurface(configured("billing", { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {} }), 10_000).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnreachableServerError);
    expect((failure as Error).message).toContain(`connection refused by 127.0.0.1:${port}`);
    // Host and port only: a path is where people put tokens, and this reason is pushed.
    expect((failure as Error).message).not.toContain("/mcp)");
  }, 20_000);
});
