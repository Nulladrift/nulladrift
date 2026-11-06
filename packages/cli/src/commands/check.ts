/** `nulladrift check` -- re-capture, diff against the lock, fail on drift. */
import { capabilityViolations, newSteering } from "@nulladrift/core";
import { dim, yellow } from "../lib/ui";
import { captureAll } from "../audit";
import { diffLockfiles } from "../diff";
import { readLockfile } from "../lock/io";
import { resolveExitCode, type ExitCode } from "../lib/exit";
import { renderHumanReport } from "../report/human";
import { renderJsonReport } from "../report/json";
import { renderSarifReport } from "../report/sarif";
import { renderMarkdownReport } from "../report/markdown";
import { targetFromEnvironment, upsertComment } from "../report/comment";
import type { AuditReport } from "../report/types";
import { reportIfChanged } from "../telemetry";
import type { CommonOptions } from "./options";

export async function buildReport(options: CommonOptions): Promise<{ report: AuditReport; exitCode: ExitCode }> {
  const committed = await readLockfile(options.lockPath);

  const result = await captureAll({
    projectRoot: options.projectRoot,
    configFiles: options.configFiles,
    timeoutMs: options.timeoutMs,
    // The committed policy governs the check, so every consumer of the repo audits identically.
    policy: committed.policy,
  });

  const changes = diffLockfiles(committed, result.lock);
  const allowUnreachable = options.allowUnreachable || committed.policy?.allowUnreachable === true;

  const report: AuditReport = {
    changes,
    /*
     * Reported, never gated. The exit code below is computed from drift and unreachable servers
     * exactly as before: a pattern that fires on "before using this tool, call authenticate
     * first" must not be able to fail somebody's build.
     */
    steering: newSteering(committed, result.lock),
    /*
     * Against the freshly read surface, not the diff. A rule saying nothing here may execute
     * processes has to fail on the day it is added, not on the next day a server happens to move.
     */
    violations: capabilityViolations(result.lock, committed.policy?.deniedCapabilities),
    unreachable: result.unreachable,
    serversChecked: Object.keys(result.lock.subjects).length,
    lockPath: options.lockPath,
    projectRoot: options.projectRoot,
  };

  return {
    report,
    exitCode: resolveExitCode({
      /*
       * A forbidden capability fails the build like drift does. It is not drift -- nothing moved
       * -- but the surface is not one the project permits, and `review --accept-all` must not be
       * able to make it pass: policy is the thing acceptance cannot overrule.
       */
      driftCount: changes.length + (report.violations?.length ?? 0),
      incompleteCount: allowUnreachable ? 0 : result.unreachable.length,
    }),
  };
}

export async function runCheck(options: CommonOptions): Promise<ExitCode> {
  const { report, exitCode } = await buildReport(options);

  if (options.format === "json") process.stdout.write(renderJsonReport(report, exitCode));
  else if (options.format === "sarif") process.stdout.write(renderSarifReport(report, { steering: options.sarifSteering }));
  else process.stdout.write(renderHumanReport(report));

  // Opt-in, and only when the picture has changed since the last delivered report.
  await reportIfChanged(report, report.changes);

  if (options.comment) await comment(report);
  return exitCode;
}


/**
 * The findings, onto the pull request being reviewed.
 *
 * Never fatal. A comment that could not be posted is worth saying out loud and is not worth
 * failing a build over: the verdict is the exit code, and a fork's read-only `GITHUB_TOKEN` is
 * the common reason this cannot write, which is a repository setting and not a finding.
 */
async function comment(report: AuditReport): Promise<void> {
  const target = targetFromEnvironment();
  if (!target) {
    process.stderr.write(`${dim("--comment: not a pull request build, so there is nowhere to comment.")}\n`);
    return;
  }

  const body = renderMarkdownReport(report);
  if (!body) return;

  try {
    const outcome = await upsertComment(target, body);
    if (outcome === "forbidden") {
      process.stderr.write(
        `${yellow("--comment:")} the token cannot write comments on this repository. A pull request from a fork gets a read-only token; give the job \`pull-requests: write\` if it is not one.\n`,
      );
      return;
    }
    process.stderr.write(`${dim(`--comment: ${outcome} the comment on #${target.issue}.`)}\n`);
  } catch (error) {
    process.stderr.write(`${yellow("--comment:")} ${(error as Error).message}\n`);
  }
}
