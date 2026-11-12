/**
 * Which project a reading belongs to, and the branch and commit it was taken at.
 *
 * Found by using the product: a push from a laptop named the project after its folder, the same
 * repository pushed from GitHub Actions named it `owner/repo`, and on a plan with room for one
 * project the CI push was refused. A laptop now names it from the git remote, the way CI does,
 * and readings from a laptop or another CI carry their branch and commit.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readingOrigin, repositoryFacts, repositoryPath } from "../src/lib/origin";

const SHA = "cb11ee97c0ffee00cb11ee97c0ffee00cb11ee97";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A repository on disk, as `git init` and one commit leave it, without running git. */
async function repository(options: { remote?: string; head?: string; loose?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-origin-"));
  dirs.push(root);
  const git = join(root, ".git");
  await mkdir(join(git, "refs", "heads"), { recursive: true });
  await writeFile(join(git, "HEAD"), `${options.head ?? "ref: refs/heads/main"}\n`);
  if (options.loose !== false) await writeFile(join(git, "refs", "heads", "main"), `${SHA}\n`);
  else await writeFile(join(git, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`);
  const remote = options.remote === undefined ? "" : `[remote "origin"]\n\turl = ${options.remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  await writeFile(join(git, "config"), `[core]\n\trepositoryformatversion = 0\n${remote}[branch "main"]\n\tremote = origin\n`);
  return root;
}

const NO_CI = {};

describe("naming a repository the way CI does", () => {
  it.each([
    ["git@github.com:ridgeline/support-bot.git", "ridgeline/support-bot"],
    ["https://github.com/ridgeline/support-bot.git", "ridgeline/support-bot"],
    ["https://github.com/ridgeline/support-bot", "ridgeline/support-bot"],
    ["ssh://git@gitlab.com:2222/group/sub/project.git", "group/sub/project"],
    ["gh:ridgeline/support-bot", "ridgeline/support-bot"],
    ["https://dev.azure.com/ridgeline/ops/_git/support-bot", "support-bot"],
  ])("reads %s as %s", (remote, expected) => {
    expect(repositoryPath(remote)).toBe(expected);
  });

  it("never carries credentials from the URL into the name", () => {
    expect(repositoryPath("https://x-access-token:ghs_secret@github.com/ridgeline/support-bot.git")).toBe("ridgeline/support-bot");
  });

  it("gives nothing for a remote it cannot read as a repository", () => {
    expect(repositoryPath("/srv/git/bare")).toBeUndefined();
    expect(repositoryPath("")).toBeUndefined();
  });
});

describe("reading the repository without running git", () => {
  it("finds the branch, the commit and the remote", async () => {
    const root = await repository({ remote: "git@github.com:ridgeline/support-bot.git" });
    expect(repositoryFacts(root)).toEqual({ project: "ridgeline/support-bot", ref: "main", commit: SHA });
  });

  it("resolves a branch that only packed-refs knows", async () => {
    const root = await repository({ loose: false });
    expect(repositoryFacts(root).commit).toBe(SHA);
  });

  it("gives a detached checkout its commit and no branch, which is what CI checkouts are", async () => {
    const root = await repository({ head: OTHER });
    expect(repositoryFacts(root)).toMatchObject({ ref: undefined, commit: OTHER });
  });

  it("finds the repository from a directory inside it", async () => {
    const root = await repository({ remote: "https://github.com/ridgeline/support-bot.git" });
    const nested = join(root, "services", "bot");
    await mkdir(nested, { recursive: true });
    expect(repositoryFacts(nested).project).toBe("ridgeline/support-bot");
  });

  it("follows a worktree's .git file to its own HEAD and the main repository's refs", async () => {
    const main = await repository({ remote: "git@github.com:ridgeline/support-bot.git" });
    const worktreeGit = join(main, ".git", "worktrees", "feature");
    await mkdir(worktreeGit, { recursive: true });
    await writeFile(join(worktreeGit, "HEAD"), "ref: refs/heads/feature\n");
    await writeFile(join(worktreeGit, "commondir"), "../..\n");
    await writeFile(join(main, ".git", "refs", "heads", "feature"), `${OTHER}\n`);
    const worktree = await mkdtemp(join(tmpdir(), "nulladrift-worktree-"));
    dirs.push(worktree);
    await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGit}\n`);
    expect(repositoryFacts(worktree)).toEqual({ project: "ridgeline/support-bot", ref: "feature", commit: OTHER });
  });

  it("says nothing outside a repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "nulladrift-plain-"));
    dirs.push(root);
    expect(repositoryFacts(root)).toEqual({});
  });
});

describe("where a reading says it came from", () => {
  it("names a laptop's push after the git remote, as GitHub Actions names the same repository", async () => {
    const root = await repository({ remote: "git@github.com:ridgeline/support-bot.git" });
    const laptop = readingOrigin(root, {}, NO_CI);
    const actions = readingOrigin(root, {}, { GITHUB_REPOSITORY: "ridgeline/support-bot", GITHUB_REF_NAME: "main", GITHUB_SHA: SHA });
    expect(laptop).toEqual({ project: "ridgeline/support-bot", projectFrom: "repository", ref: "main", commit: SHA });
    expect(actions).toEqual({ project: "ridgeline/support-bot", projectFrom: "ci", ref: "main", commit: SHA });
  });

  it("falls back to the folder only when nothing else names it, and says so", async () => {
    const root = await repository();
    const origin = readingOrigin(root, {}, NO_CI);
    expect(origin.projectFrom).toBe("folder");
    expect(origin.project).toBe(root.split("/").pop());
    // Still a repository, so the branch and commit are known.
    expect(origin).toMatchObject({ ref: "main", commit: SHA });
  });

  it("lets a flag win over everything", async () => {
    const root = await repository({ remote: "git@github.com:ridgeline/support-bot.git" });
    const origin = readingOrigin(root, { project: "support-bot", ref: "release", commit: OTHER }, { GITHUB_REPOSITORY: "ridgeline/other", GITHUB_REF_NAME: "main" });
    expect(origin).toEqual({ project: "support-bot", projectFrom: "flag", ref: "release", commit: OTHER });
  });

  it.each([
    ["GitLab", { CI_PROJECT_PATH: "group/support-bot", CI_COMMIT_REF_NAME: "main", CI_COMMIT_SHA: SHA }, "group/support-bot"],
    ["Azure Pipelines", { BUILD_REPOSITORY_NAME: "support-bot", BUILD_SOURCEBRANCH: "refs/heads/main", BUILD_SOURCEVERSION: SHA }, "support-bot"],
    ["Bitbucket", { BITBUCKET_REPO_FULL_NAME: "ridgeline/support-bot", BITBUCKET_BRANCH: "main", BITBUCKET_COMMIT: SHA }, "ridgeline/support-bot"],
    ["CircleCI", { CIRCLE_PROJECT_USERNAME: "ridgeline", CIRCLE_PROJECT_REPONAME: "support-bot", CIRCLE_BRANCH: "main", CIRCLE_SHA1: SHA }, "ridgeline/support-bot"],
    ["Buildkite", { BUILDKITE_REPO: "git@github.com:ridgeline/support-bot.git", BUILDKITE_BRANCH: "main", BUILDKITE_COMMIT: SHA }, "ridgeline/support-bot"],
  ])("reads %s's own variables for the project, branch and commit", async (_provider, env, project) => {
    const root = await mkdtemp(join(tmpdir(), "nulladrift-ci-"));
    dirs.push(root);
    expect(readingOrigin(root, {}, env)).toEqual({ project, projectFrom: "ci", ref: "main", commit: SHA });
  });

  it("treats an empty CI variable as unset", async () => {
    const root = await repository({ remote: "git@github.com:ridgeline/support-bot.git" });
    expect(readingOrigin(root, {}, { GITHUB_REPOSITORY: "", GITHUB_REF_NAME: " " })).toMatchObject({ project: "ridgeline/support-bot", ref: "main" });
  });
});
