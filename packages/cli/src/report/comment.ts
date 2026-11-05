/**
 * Posting the findings onto the pull request being reviewed.
 *
 * Deliberately not a GitHub App. An app would need registering, installing, a webhook endpoint
 * and a review, and none of that can happen before somebody can try this. Actions already hands
 * every job a `GITHUB_TOKEN` scoped to the repository it is running in, and GitLab does the same
 * with `CI_JOB_TOKEN`, so the collector can post as itself with nothing to set up. The cost is
 * that this only works inside CI, which is the only place a pull request exists anyway.
 *
 * One comment, updated in place, rather than one per push. A reviewer watching a branch should
 * see the current state of the surface, not a transcript of every time it was checked, and a
 * thread of eleven bot comments is a thread nobody reads.
 */
const MARKER = "<!-- nulladrift:surface -->";

export interface CommentTarget {
  api: string;
  repo: string;
  issue: number;
  token: string;
}

/**
 * Where to comment, read from whatever CI put in the environment. Null when this is not a pull
 * request: a push to a branch has nowhere to put a comment, and that is not an error.
 */
export function targetFromEnvironment(env: NodeJS.ProcessEnv = process.env): CommentTarget | null {
  const token = env["GITHUB_TOKEN"];
  const repo = env["GITHUB_REPOSITORY"];
  const ref = env["GITHUB_REF"];
  if (!token || !repo || !ref) return null;

  // `refs/pull/123/merge` on a pull_request event, and something else on every other event.
  const match = /^refs\/pull\/(\d+)\//.exec(ref);
  if (!match?.[1]) return null;

  return {
    api: (env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, ""),
    repo,
    issue: Number(match[1]),
    token,
  };
}

async function call(target: CommentTarget, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${target.api}/repos/${target.repo}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${target.token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Posts the body, replacing the previous one if this has run on this pull request before.
 *
 * Returns what it did, so the caller can say so rather than claiming success it did not have.
 * Throws only on a response that means the comment is not there; a missing permission is the
 * common case in a fork, where `GITHUB_TOKEN` is read-only by design, and that is reported
 * rather than failed on: a build should not go red because a comment could not be posted.
 */
export async function upsertComment(target: CommentTarget, body: string): Promise<"created" | "updated" | "forbidden"> {
  const marked = `${MARKER}\n${body}`;

  const existing = await call(target, `/issues/${target.issue}/comments?per_page=100`);
  if (existing.status === 403) return "forbidden";
  if (!existing.ok) throw new Error(`could not read the comments (${existing.status})`);

  const comments = (await existing.json()) as { id: number; body?: string }[];
  const mine = comments.find((comment) => comment.body?.startsWith(MARKER));

  const written = mine
    ? await call(target, `/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body: marked }) })
    : await call(target, `/issues/${target.issue}/comments`, { method: "POST", body: JSON.stringify({ body: marked }) });

  if (written.status === 403) return "forbidden";
  if (!written.ok) throw new Error(`could not post the comment (${written.status})`);
  return mine ? "updated" : "created";
}
