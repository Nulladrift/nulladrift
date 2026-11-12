/**
 * Which project a reading belongs to, and which branch and commit it was taken at.
 *
 * These were read from GitHub's and GitLab's variables and nothing else. So a push from a laptop
 * named the project after its folder (`support-bot`) while the same repository pushed from
 * GitHub Actions named it `owner/support-bot`: two projects for one repository, and on a plan
 * with room for one, the CI push -- the one that matters -- was refused. Readings from a laptop or
 * from any other CI also carried no branch or commit, so the record could not say where they came
 * from. Found by using the product.
 *
 * Now, in order: a flag; the CI provider's own variables, for every provider that sets them; and
 * the repository itself, read from `.git`, so that a laptop names the project the way its CI will.
 * The folder name is the last resort, and the push says when it was used.
 *
 * `.git` is read as files rather than by running `git`. The collector runs inside repositories
 * it does not control, and git's own configuration -- `core.fsmonitor`, hooks, aliases -- is a
 * way for a repository to run code in whatever process invokes git there.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ProjectSource = "flag" | "ci" | "repository" | "folder";

export interface ReadingOrigin {
  project: string;
  projectFrom: ProjectSource;
  ref?: string;
  commit?: string;
}

/** The control plane's limits on each field. Anything longer is dropped rather than refused there. */
const MAX_PROJECT = 200;
const MAX_REF = 200;

type Env = Record<string, string | undefined>;

/** The first of these variables that is set to something. An empty variable is not an answer. */
function first(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** `refs/heads/main` as `main`; the short form every provider's own branch variable uses. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

/**
 * `owner/repo` from a remote URL, in the shape CI names the same repository: GitHub's
 * `GITHUB_REPOSITORY`, GitLab's `CI_PROJECT_PATH` (subgroups included), Bitbucket's
 * `BITBUCKET_REPO_FULL_NAME`. Azure Repos names a repository by its last segment, and so does
 * `BUILD_REPOSITORY_NAME`. Credentials in the URL are never part of the answer.
 */
export function repositoryPath(remote: string): string | undefined {
  const url = remote.trim();
  let path: string | undefined;
  // scp-like: git@github.com:owner/repo.git, or an ssh alias such as gh:owner/repo
  const scp = /^(?:[^/@:\s]+@)?[^/:\s\\]{2,}:(?!\/)([^\\]+)$/.exec(url);
  if (scp) path = scp[1];
  else {
    try {
      path = new URL(url).pathname;
    } catch {
      return undefined;
    }
  }
  const azure = /\/_git\/([^/]+)/.exec(path ?? "");
  if (azure) path = azure[1];
  const cleaned = (path ?? "").replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return cleaned && !cleaned.includes("..") ? cleaned : undefined;
}

/** The project as the CI provider names it, for the providers that name it at all. */
function projectFromCi(env: Env): string | undefined {
  const named = first(env, "GITHUB_REPOSITORY", "CI_PROJECT_PATH", "BITBUCKET_REPO_FULL_NAME", "BUILD_REPOSITORY_NAME");
  if (named) return named;
  const user = first(env, "CIRCLE_PROJECT_USERNAME");
  const repo = first(env, "CIRCLE_PROJECT_REPONAME");
  if (user && repo) return `${user}/${repo}`;
  const buildkite = first(env, "BUILDKITE_REPO");
  return buildkite ? repositoryPath(buildkite) : undefined;
}

function refFromCi(env: Env): string | undefined {
  const ref = first(
    env,
    "GITHUB_REF_NAME",
    "CI_COMMIT_REF_NAME",
    "BUILD_SOURCEBRANCH",
    "BITBUCKET_BRANCH",
    "BITBUCKET_TAG",
    "CIRCLE_BRANCH",
    "CIRCLE_TAG",
    "BUILDKITE_BRANCH",
  );
  return ref ? shortRef(ref) : undefined;
}

function commitFromCi(env: Env): string | undefined {
  return first(env, "GITHUB_SHA", "CI_COMMIT_SHA", "BUILD_SOURCEVERSION", "BITBUCKET_COMMIT", "CIRCLE_SHA1", "BUILDKITE_COMMIT");
}

/** A small text file, or nothing. Never throws: a repository this cannot read is just not one. */
function read(path: string): string | undefined {
  try {
    if (!statSync(path).isFile() || statSync(path).size > 4 * 1024 * 1024) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The repository's own directories: where HEAD lives, and where refs and config are shared from.
 * A worktree or a submodule has a `.git` file pointing elsewhere, and a worktree's refs and config
 * live in the main repository, named by `commondir`.
 */
function gitDirectories(start: string): { gitDir: string; commonDir: string } | undefined {
  let dir = resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      try {
        if (statSync(dotGit).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? "")?.[1]?.trim();
          if (!pointer) return undefined;
          gitDir = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
        }
      } catch {
        return undefined;
      }
      const common = read(join(gitDir, "commondir"))?.trim();
      return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** A ref's commit, from its loose file or from `packed-refs`. */
function resolveRef(commonDir: string, ref: string): string | undefined {
  if (!/^refs\/[\w./-]+$/.test(ref) || ref.includes("..")) return undefined;
  const loose = read(join(commonDir, ref))?.trim();
  if (loose && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
  for (const line of (read(join(commonDir, "packed-refs")) ?? "").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  return undefined;
}

/** The URL of `origin`, or of the first remote when there is no `origin`. */
function remoteUrl(commonDir: string): string | undefined {
  const config = read(join(commonDir, "config"));
  if (!config) return undefined;
  const remotes = new Map<string, string>();
  let current: string | undefined;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
    if (section) {
      current = section[1];
      continue;
    }
    if (line.startsWith("[")) {
      current = undefined;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (current && url?.[1] && !remotes.has(current)) remotes.set(current, url[1].trim());
  }
  return remotes.get("origin") ?? remotes.values().next().value;
}

/** What the repository at or above `root` says about itself, read from `.git`. */
export function repositoryFacts(root: string): { project?: string; ref?: string; commit?: string } {
  const dirs = gitDirectories(root);
  if (!dirs) return {};
  const head = read(join(dirs.gitDir, "HEAD"))?.trim() ?? "";
  const symbolic = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
  const commit = symbolic ? resolveRef(dirs.commonDir, symbolic) : /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
  const remote = remoteUrl(dirs.commonDir);
  return {
    project: remote ? repositoryPath(remote) : undefined,
    // A detached HEAD has a commit and no branch, which is what CI checkouts usually are.
    ref: symbolic?.startsWith("refs/heads/") ? shortRef(symbolic) : undefined,
    commit,
  };
}

/** Where this reading comes from, from flags, then CI, then the repository, then the folder. */
export function readingOrigin(
  root: string,
  flags: { project?: string; ref?: string; commit?: string },
  env: Env = process.env,
): ReadingOrigin {
  const repo = repositoryFacts(root);
  const usable = (value: string | undefined, max: number) => (value && value.length <= max ? value : undefined);

  let project: string;
  let projectFrom: ProjectSource;
  const ci = usable(projectFromCi(env), MAX_PROJECT);
  const fromRepo = usable(repo.project, MAX_PROJECT);
  if (flags.project) {
    project = flags.project;
    projectFrom = "flag";
  } else if (ci) {
    project = ci;
    projectFrom = "ci";
  } else if (fromRepo) {
    project = fromRepo;
    projectFrom = "repository";
  } else {
    project = resolve(root).split(/[\\/]/).filter(Boolean).pop() ?? "default";
    projectFrom = "folder";
  }

  return {
    project,
    projectFrom,
    ref: flags.ref ?? usable(refFromCi(env), MAX_REF) ?? usable(repo.ref, MAX_REF),
    commit: flags.commit ?? commitFromCi(env) ?? repo.commit,
  };
}
