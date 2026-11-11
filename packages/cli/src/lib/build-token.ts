/**
 * Asking the CI provider to vouch for this build.
 *
 * A reading names its own ref and commit, and the control plane can only take the request's word
 * for them -- so anyone holding the collector token could report any branch as clean. GitHub
 * Actions and GitLab CI will each mint a short-lived identity token for a job, signed by the
 * provider, with the repository, ref and commit filled in by the provider rather than the job.
 * Sending it lets the control plane believe a reading's account of itself on the provider's word.
 *
 * Optional, and never a reason to fail. No token means the reading is recorded as unverified,
 * which is what every reading was before this existed; whether that blocks is the organization's
 * policy, decided on the control plane.
 */

/** The header the control plane reads it from. Kept in step with the server by hand: two repos. */
export const BUILD_TOKEN_HEADER = "nulladrift-build-token";

/** What the token must be minted for. The control plane checks it, so a token for another service is refused. */
export const DEFAULT_AUDIENCE = "nulladrift";

/**
 * Where a token minted for one reading's exact bytes goes. Kept in step with the server by hand.
 *
 * The build token says which build sent a reading, not what it said: anyone holding it for its
 * few minutes, with the collector token, could send other contents as that build. This one is
 * the same provider-signed token, minted for an audience that carries the sha256 of the request
 * body, so the provider's signature covers the bytes too. Both are sent, because a control plane
 * from before 0.7.0 knows only the build token.
 */
export const READING_TOKEN_HEADER = "nulladrift-reading-token";

/** The audience a reading token is minted for. Must match the control plane's, byte for byte. */
export function readingAudience(base: string, digest: string): string {
  return `${base.replace(/\/+$/, "")}#sha256:${digest}`;
}

/**
 * Whom a reading token is for: `NULLADRIFT_BUILD_AUDIENCE` when it is set, which the control
 * plane accepts too, and otherwise the origin of the address being pushed to. Naming the control
 * plane is what stops a token sent to one being replayed against another; the build token's fixed
 * `nulladrift` could be.
 */
export function readingAudienceBase(apiUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  return env["NULLADRIFT_BUILD_AUDIENCE"] || new URL(apiUrl).origin;
}

export type BuildToken = { token: string; source: "github-actions" | "environment" };

/** Said once, in the push output, when a token could have been sent and was not. */
export type BuildTokenHint = { hint: string };

export interface AcquireOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The token for this build, a hint about how to get one, or nothing at all outside CI.
 *
 * `NULLADRIFT_ID_TOKEN` comes first, because it is the one somebody set on purpose: GitLab's
 * `id_tokens:` puts a token in a variable of your choosing, and any other provider can do the
 * same. GitHub Actions is asked directly, which works only when the job has
 * `permissions: id-token: write` -- the request URL is absent otherwise, and that absence is the
 * one case worth a hint, since the fix is a single line in the workflow.
 */
export async function acquireBuildToken(options: AcquireOptions = {}): Promise<BuildToken | BuildTokenHint | undefined> {
  const env = options.env ?? process.env;
  const explicit = env["NULLADRIFT_ID_TOKEN"];
  if (explicit) return { token: explicit, source: "environment" };

  if (env["GITHUB_ACTIONS"] !== "true") return undefined;
  /*
   * `||`, as the reading audience reads it, not `??`. A workflow's `${{ vars.X }}` for an unset
   * variable is the empty string, and that asked GitHub for a token with an empty audience, which
   * the control plane was never going to accept for this and something else might.
   */
  return fromGithubActions(env["NULLADRIFT_BUILD_AUDIENCE"] || DEFAULT_AUDIENCE, env, options);
}

/**
 * A token minted for this reading's bytes, on GitHub Actions, which mints one for any audience
 * the job asks. Nothing elsewhere: GitLab's `id_tokens:`, and any token handed over in
 * `NULLADRIFT_ID_TOKEN`, are minted before the job runs, for an audience fixed in the pipeline
 * file, so they cannot carry a hash of what the job went on to find.
 */
export async function acquireReadingToken(audience: string, options: AcquireOptions = {}): Promise<BuildToken | BuildTokenHint | undefined> {
  const env = options.env ?? process.env;
  if (env["GITHUB_ACTIONS"] !== "true") return undefined;
  return fromGithubActions(audience, env, options);
}

async function fromGithubActions(audience: string, env: NodeJS.ProcessEnv, options: AcquireOptions): Promise<BuildToken | BuildTokenHint> {
  const requestUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const requestToken = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!requestUrl || !requestToken) {
    return { hint: "add `permissions: id-token: write` to this job so the reading can prove which build sent it" };
  }

  try {
    const url = new URL(requestUrl);
    url.searchParams.set("audience", audience);
    const response = await (options.fetch ?? fetch)(url, {
      headers: { authorization: `bearer ${requestToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return { hint: `GitHub Actions would not mint an identity token (HTTP ${response.status})` };
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== "string" || body.value.length === 0) return { hint: "GitHub Actions returned no identity token" };
    return { token: body.value, source: "github-actions" };
  } catch (error) {
    return { hint: `could not reach GitHub Actions for an identity token: ${(error as Error).message}` };
  }
}
