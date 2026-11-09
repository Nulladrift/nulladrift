/**
 * Asking the CI provider to vouch for this build.
 *
 * Optional by design: no token means an unverified reading, which is what every reading was
 * before this existed. So the property worth testing hardest is that nothing here can fail a push.
 */
import { describe, expect, it } from "vitest";
import { acquireBuildToken, acquireReadingToken, DEFAULT_AUDIENCE, readingAudience, readingAudienceBase } from "../src/lib/build-token";

const ACTIONS = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/oidc/token?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
};

function provider(answer: { status?: number; body?: unknown } | Error) {
  const asked: Array<{ url: string; authorization?: string }> = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), authorization: (init?.headers as Record<string, string>)["authorization"] });
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetch: fake, asked };
}

describe("getting a build token", () => {
  it("asks GitHub Actions for one minted for this audience", async () => {
    const { fetch, asked } = provider({ body: { value: "eyJ.signed.token" } });
    expect(await acquireBuildToken({ env: ACTIONS, fetch })).toEqual({ token: "eyJ.signed.token", source: "github-actions" });

    const url = new URL(asked[0]!.url);
    // The audience is what stops a token minted for some other service being replayed here.
    expect(url.searchParams.get("audience")).toBe(DEFAULT_AUDIENCE);
    // And the runner's own query string survives being added to.
    expect(url.searchParams.get("api-version")).toBe("2.0");
    expect(asked[0]!.authorization).toBe("bearer runner-request-token");
  });

  it("honours an audience the control plane was configured with", async () => {
    const { fetch, asked } = provider({ body: { value: "t" } });
    await acquireBuildToken({ env: { ...ACTIONS, NULLADRIFT_BUILD_AUDIENCE: "nulladrift-acme" }, fetch });
    expect(new URL(asked[0]!.url).searchParams.get("audience")).toBe("nulladrift-acme");
  });

  it("prefers a token somebody set on purpose, which is how GitLab's id_tokens arrive", async () => {
    const { fetch, asked } = provider({ body: { value: "from-github" } });
    expect(await acquireBuildToken({ env: { ...ACTIONS, NULLADRIFT_ID_TOKEN: "from-gitlab" }, fetch })).toEqual({ token: "from-gitlab", source: "environment" });
    expect(asked).toHaveLength(0);
  });

  it("says how to turn it on when the job lacks the permission", async () => {
    // The request URL only exists with `id-token: write`. Its absence is the one-line fix worth naming.
    const result = await acquireBuildToken({ env: { GITHUB_ACTIONS: "true" } });
    expect(result).toEqual({ hint: expect.stringContaining("permissions: id-token: write") });
  });

  it("stays quiet outside CI, where there is nothing to vouch for", async () => {
    expect(await acquireBuildToken({ env: {} })).toBeUndefined();
  });

  it("turns every failure into a hint rather than an error", async () => {
    expect(await acquireBuildToken({ env: ACTIONS, fetch: provider({ status: 403 }).fetch })).toEqual({ hint: expect.stringContaining("HTTP 403") });
    expect(await acquireBuildToken({ env: ACTIONS, fetch: provider({ body: {} }).fetch })).toEqual({ hint: expect.stringContaining("no identity token") });
    expect(await acquireBuildToken({ env: ACTIONS, fetch: provider(new TypeError("fetch failed")).fetch })).toEqual({
      hint: expect.stringContaining("fetch failed"),
    });
  });
});

describe("getting a token for one reading's bytes", () => {
  const DIGEST = "a".repeat(64);

  it("names the control plane and the reading's sha256 in the audience", () => {
    expect(readingAudience("https://api.nulladrift.example/", DIGEST)).toBe(`https://api.nulladrift.example#sha256:${DIGEST}`);
  });

  it("names the control plane by the origin pushed to, unless an audience was configured", () => {
    expect(readingAudienceBase("https://api.nulladrift.example/v1/", {})).toBe("https://api.nulladrift.example");
    expect(readingAudienceBase("https://api.nulladrift.example", { NULLADRIFT_BUILD_AUDIENCE: "nulladrift-acme" })).toBe("nulladrift-acme");
  });

  it("asks GitHub Actions for one minted for that audience", async () => {
    const { fetch, asked } = provider({ body: { value: "eyJ.reading.token" } });
    const audience = readingAudience("https://api.nulladrift.example", DIGEST);
    expect(await acquireReadingToken(audience, { env: ACTIONS, fetch })).toEqual({ token: "eyJ.reading.token", source: "github-actions" });
    expect(new URL(asked[0]!.url).searchParams.get("audience")).toBe(audience);
  });

  it("asks for nothing outside GitHub Actions, where a token's audience is fixed before the job runs", async () => {
    const { fetch, asked } = provider({ body: { value: "t" } });
    expect(await acquireReadingToken("x", { env: { NULLADRIFT_ID_TOKEN: "from-gitlab" }, fetch })).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
