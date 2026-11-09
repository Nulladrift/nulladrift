/** What the lock leaves out of a transport because a config wrote a credential literally. */
import { describe, expect, it } from "vitest";
import { countRedacted, REDACTED, redactArgs, redactPath } from "../src/lock/credentials";
import { sanitizeUrl } from "../src/lock/normalize";

describe("redactArgs", () => {
  it("replaces a credential its issuer's format gives away, inside a larger argument too", () => {
    expect(
      redactArgs([
        "AKIAIOSFODNN7EXAMPLE",
        "--header=Authorization: Bearer xoxb-1234567890-abcdefghij",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ]),
    ).toEqual([REDACTED, `--header=Authorization: Bearer ${REDACTED}`, REDACTED]);
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
    expect(redactPath("/repos/0f8fad5b-d9cb-469f-a165-70867728950e/mcp")).toBe("/repos/0f8fad5b-d9cb-469f-a165-70867728950e/mcp");
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
