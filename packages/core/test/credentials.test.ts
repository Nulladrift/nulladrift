/** What the lock leaves out of a transport because a config wrote a credential literally. */
import { describe, expect, it } from "vitest";
import { countRedacted, isCredentialName, REDACTED, redactArgs, redactPath } from "../src/lock/credentials";
import { sanitizeUrl } from "../src/lock/normalize";

describe("redactArgs", () => {
  it("replaces a credential its issuer's format gives away, inside a larger argument too", () => {
    expect(
      redactArgs([
        "AKIAIOSFODNN7EXAMPLE",
        "--header=Authorization: Bearer xoxb-1234567890-abcdefghij",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ]),
    ).toEqual([REDACTED, `--header=Authorization: ${REDACTED}`, REDACTED]);
  });

  it("keeps a URL argument readable and takes out only its password and credential parameters", () => {
    expect(redactArgs(["https://api.example.com/v1?region=eu&api_key=k3y-value-here"])).toEqual([
      `https://api.example.com/v1?region=eu&api_key=${REDACTED}`,
    ]);
    expect(redactArgs(["mysql://root:hunter2@localhost/app"])).toEqual([`mysql://root:${REDACTED}@localhost/app`]);
  });

  it("leaves a flag's value alone when it is a path, a URL or a placeholder rather than the secret", () => {
    const args = ["--token", "/run/secrets/token", "--api-key", "$API_KEY", "--secret", "${input:secret}"];
    expect(redactArgs(args)).toEqual(args);
  });

  it("returns the arguments in place, so any other change to them is still drift", () => {
    expect(redactArgs(["a", "--password", "pw", "b"])).toEqual(["a", "--password", REDACTED, "b"]);
  });
});

describe("redactPath and sanitizeUrl", () => {
  it("replaces only the segment of a path that is a key", () => {
    expect(redactPath("/api/v1/Zq8xT3vNw7Kd2Lp9Rf4Hc6Jm1Sb5Ya0G/sse")).toBe(`/api/v1/${REDACTED}/sse`);
    // A UUID in a hosted server's path is its key more often than not (Pipedream, Composio).
    expect(redactPath("/repos/0f8fad5b-d9cb-469f-a165-70867728950e/mcp")).toBe(`/repos/${REDACTED}/mcp`);
    expect(redactPath("/v1/repos/acme/web")).toBe("/v1/repos/acme/web");
  });

  it("is applied by sanitizeUrl along with the query, fragment and userinfo it already drops", () => {
    expect(sanitizeUrl("https://u:p@mcp.example.com/k/ghp_abcdefghijklmnopqrstuvwxyz0123456789/mcp?x=1#f")).toBe(
      `https://mcp.example.com/k/${REDACTED}/mcp`,
    );
  });
});

describe("countRedacted", () => {
  it("counts what was left out of a locked transport, for saying so", () => {
    expect(countRedacted({ args: ["--api-key", REDACTED, `-e=TOKEN=${REDACTED}`] })).toBe(2);
    expect(countRedacted({ url: `https://host/${REDACTED}/mcp` })).toBe(1);
    expect(countRedacted({ args: ["serve"] })).toBe(0);
  });
});

/*
 * The shapes real configs use that 0.6.1 let through: found in a review, each reached mcp.lock and
 * the reading push sends. Each pair is the argument as written and as it has to be locked.
 */
describe("redactArgs, on the shapes configs actually use", () => {
  it.each([
    [["--key", "3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6"], ["--key", REDACTED]],
    [["--header", "Authorization: Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0"], ["--header", `Authorization: ${REDACTED}`]],
    [["--header", "Authorization:Basic YWxpY2U6aHVudGVyMg=="], ["--header", `Authorization: ${REDACTED}`]],
    [["--header=X-Api-Key: abc123"], [`--header=X-Api-Key: ${REDACTED}`]],
    [["--config", '{"braveApiKey":"BSAabcdef1234567890","region":"eu"}'], ["--config", `{"braveApiKey":"${REDACTED}","region":"eu"}`]],
    [["https://h.example/sse?key=abc123&sig=xyz&region=eu"], [`https://h.example/sse?key=${REDACTED}&sig=${REDACTED}&region=eu`]],
    [["https://h.example/cb#access_token=abc123"], [`https://h.example/cb#access_token=${REDACTED}`]],
    [["https://mcp.pipedream.net/3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6/github"], [`https://mcp.pipedream.net/${REDACTED}/github`]],
    [["--githubToken", "abc123"], ["--githubToken", REDACTED]],
    [["GITHUB_PAT=abc123", "FIRECRAWL_KEY=abc", "DD_API_KEY_SECONDARY=abc"], [`GITHUB_PAT=${REDACTED}`, `FIRECRAWL_KEY=${REDACTED}`, `DD_API_KEY_SECONDARY=${REDACTED}`]],
    [["Server=db;Password=Hunter2!"], [`Server=db;Password=${REDACTED}`]],
    [["jdbc:postgresql://db/app?user=app&password=pw"], [`jdbc:postgresql://db/app?user=app&password=${REDACTED}`]],
    [["-u", "alice:hunter2"], ["-u", `alice:${REDACTED}`]],
  ])("%j", (written, locked) => {
    expect(redactArgs(written)).toEqual(locked);
  });
});

/*
 * And what must not be touched: a false positive hides a real change to how a server is started,
 * which is the thing the lock exists to show.
 */
describe("redactArgs, leaving ordinary arguments alone", () => {
  it.each([
    [["--max-tokens", "4096", "--tokenizer", "cl100k"]],
    [["--key-file", "./keys/server.pem", "--token-file", "/run/secrets/token", "--auth-type", "bearer", "--key-id", "abc123"]],
    [["--no-auth", "server.js"]],
    [["--auth", "@scope/pkg", "--token", "./token.txt"]],
    [["--id", "0f8fad5b-d9cb-469f-a165-70867728950e", "--commit", "4f2c9e1b7d"]],
    [["--header", "Accept: application/json"]],
    [["--config", '{"region":"eu","verbose":true}']],
    [["https://api.example.com/v1/repos/acme/web?page=2"]],
    [["--token=${API_TOKEN}", "--header", "Authorization: Bearer ${TOKEN}", "API_KEY=$API_KEY"]],
  ])("%j", (written) => {
    expect(redactArgs(written)).toEqual(written);
  });

  it("reads a credential word anywhere in a name, and not a name about one", () => {
    for (const name of ["--key", "GITHUB_PAT", "braveApiKey", "DD_API_KEY_SECONDARY", "x-api-key", "client_secret"]) expect(isCredentialName(name), name).toBe(true);
    for (const name of ["--max-tokens", "--key-file", "--auth-type", "--token-file", "--key-id", "--no-auth", "--keyboard", "--pattern", "--passthrough"]) expect(isCredentialName(name), name).toBe(false);
  });
});

describe("sanitizeUrl on an address it cannot parse", () => {
  it("still drops the query, fragment and userinfo", () => {
    expect(sanitizeUrl("https://host:${PORT}/mcp?token=literal#x")).toBe("https://host:${PORT}/mcp");
    expect(sanitizeUrl("https://u:p@${HOST}/mcp?api_key=literal")).toBe("https://${HOST}/mcp");
  });
});
