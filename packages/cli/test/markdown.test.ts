/**
 * The pull request comment.
 *
 * Two things matter here and only one is cosmetic. The comment has to be readable by somebody
 * already reading a diff, and it has to survive being written by the thing it is reporting on:
 * a tool description is attacker-controlled, so text that arrives from a server must not be able
 * to author Markdown in a comment posted by CI.
 */
import { describe, expect, it } from "vitest";
import type { Change } from "../src/diff/types";
import { renderMarkdownReport } from "../src/report/markdown";
import { targetFromEnvironment } from "../src/report/comment";
import type { AuditReport } from "../src/report/types";

const change = (overrides: Partial<Change> = {}): Change =>
  ({
    kind: "tool.description.changed",
    severity: "high",
    server: "payments",
    member: "create_refund",
    summary: "description changed (48 → 121 characters)",
    ...overrides,
  }) as Change;

const report = (overrides: Partial<AuditReport> = {}): AuditReport => ({
  changes: [],
  unreachable: [],
  serversChecked: 1,
  lockPath: "mcp.lock",
  ...overrides,
});

describe("what gets posted", () => {
  it("says nothing at all when nothing moved", () => {
    // A bot that comments on every green pull request is a bot people mute, and a muted bot is
    // one nobody reads on the day it matters.
    expect(renderMarkdownReport(report())).toBeNull();
  });

  it("leads with the count and the worst severity", () => {
    const body = renderMarkdownReport(report({ changes: [change(), change({ severity: "low" })] }));

    expect(body).toContain("2 changes to what your agents can reach, 1 high");
  });

  it("names the member, not just the server", () => {
    const body = renderMarkdownReport(report({ changes: [change()] }));

    expect(body).toContain("payments/create_refund");
    expect(body).toContain("description changed");
  });

  it("reports what could not be read, and whether it was refused or missing", () => {
    const body = renderMarkdownReport(
      report({ unreachable: [{ server: "billing", reason: "401 from the endpoint", kind: "auth" }] }),
    );

    expect(body).toContain("refused the audit");
    expect(body).toContain("billing");
  });

  it("links to the control plane when there is one to link to", () => {
    expect(renderMarkdownReport(report({ changes: [change()] }), { url: "https://app.example/drift" })).toContain(
      "https://app.example/drift",
    );
    // Without one, it says what to run instead of pointing nowhere.
    expect(renderMarkdownReport(report({ changes: [change()] }))).toContain("nulladrift review");
  });
});

/*
 * The server being reported on writes this text. A description is exactly the field this product
 * exists to watch change, and it lands in a comment posted by CI with the repository's own token.
 */
describe("text from a server cannot author the comment", () => {
  it("escapes a pipe, so it cannot break out of the table cell", () => {
    const body = renderMarkdownReport(report({ changes: [change({ summary: "a | b | c" })] }));

    expect(body).toContain("a \\| b \\| c");
  });

  it("escapes a backtick, so it cannot end the code span and start its own Markdown", () => {
    const body = renderMarkdownReport(report({ changes: [change({ server: "x`y" })] }));

    expect(body).toContain("x\\`y");
  });

  it("flattens a newline, so a summary cannot add rows to the table", () => {
    const body = renderMarkdownReport(report({ changes: [change({ summary: "first\n| evil | row | here |" })] }));

    expect(body).not.toMatch(/\n\| evil/);
  });
});

describe("where to comment", () => {
  it("finds the pull request from what Actions sets", () => {
    const target = targetFromEnvironment({
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "acme/web",
      GITHUB_REF: "refs/pull/412/merge",
    } as NodeJS.ProcessEnv);

    expect(target).toEqual({ api: "https://api.github.com", repo: "acme/web", issue: 412, token: "t" });
  });

  it("honours a GitHub Enterprise api url", () => {
    const target = targetFromEnvironment({
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "acme/web",
      GITHUB_REF: "refs/pull/1/merge",
      GITHUB_API_URL: "https://github.acme.example/api/v3/",
    } as NodeJS.ProcessEnv);

    expect(target?.api).toBe("https://github.acme.example/api/v3");
  });

  it("is null on a branch push, which has nowhere to comment", () => {
    // Not an error. Most builds are not pull requests and should say nothing about it.
    expect(
      targetFromEnvironment({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/web", GITHUB_REF: "refs/heads/main" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("is null outside CI entirely", () => {
    expect(targetFromEnvironment({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

/*
 * The sharpest thing in a report is an absence. A surface that moved beside a version bump is a
 * release; one that moved while the version stayed put means nothing was published, which is the
 * shape this product exists for. A reviewer should not have to notice a thing that is not there.
 */
describe("the version that did not change", () => {
  it("says so when a surface moved and nothing shipped", () => {
    const body = renderMarkdownReport(report({ changes: [change()] }));

    expect(body).toContain("without shipping a new version");
    expect(body).toContain("payments");
  });

  it("stays quiet when the version moved too, because that is a release", () => {
    const body = renderMarkdownReport(
      report({
        changes: [change(), change({ kind: "server.identity.changed", member: undefined, summary: "version 1.0.15 → 1.0.16" })],
      }),
    );

    expect(body).not.toContain("without shipping a new version");
  });

  it("names only the servers that were quiet, not every server that moved", () => {
    const body = renderMarkdownReport(
      report({
        changes: [
          change({ server: "payments" }),
          change({ server: "filesystem" }),
          change({ server: "filesystem", kind: "server.identity.changed", summary: "version 2.0.0 → 2.1.0" }),
        ],
      }),
    );

    expect(body).toMatch(/without shipping a new version:\*\* `payments`/);
    expect(body).not.toMatch(/without shipping a new version:\*\* .*filesystem/);
  });
});
