/**
 * `nulladrift push` -- capture the current surface and send it to a control plane, which decides
 * the verdict.
 *
 * The exit code comes from the server, not from here. That is the point of pushing rather than
 * checking: policy lives where the repository being audited cannot edit it, so a pull request
 * cannot widen what its own build is allowed to do.
 */
import { captureAll } from "../audit";
import { EXIT_CLEAN, EXIT_DRIFT, EXIT_INCOMPLETE, type ExitCode } from "../lib/exit";
import { bold, dim, green, red, yellow } from "../lib/ui";
import { describeRefusal } from "../report/push-error";
import { acquireBuildToken, BUILD_TOKEN_HEADER } from "../lib/build-token";
import { VERSION } from "../lib/version";
import type { CommonOptions } from "./options";

export interface PushOptions extends CommonOptions {
  apiUrl?: string;
  token?: string;
  project?: string;
  ref?: string;
  commit?: string;
  /**
   * Marks this as a scheduled reading rather than one a build asked for.
   *
   * A build tells you the surface was right when you shipped. It cannot tell you the surface is
   * still right at three in the morning, and a server that changes the day after a release is
   * unobserved until the next one: on a weekly cadence that is six days of an agent running
   * against something nobody approved. Running the collector on a schedule closes that, and the
   * context is what lets a reader tell the two apart afterwards.
   */
  watch?: boolean;
}

interface IngestResponseBody {
  readingId: string;
  verdict: "clean" | "drift" | "blocked";
  exitCode: 0 | 1 | 2;
  changes: Array<{ kind: string; severity: string; server: string; member?: string; summary: string }>;
  decision: { blocked: boolean; reasons: Array<{ code: string; message: string }> };
  url: string;
  /** Absent from a control plane older than signed readings, which is read as nothing to say. */
  identity?: {
    trust: "trusted" | "verified" | "unverified";
    repository?: string;
    ref?: string;
    rejected?: string;
  };
}

/** One line about which build the control plane believes sent this, or nothing worth a line. */
function describeIdentity(identity: IngestResponseBody["identity"], hint: string | undefined): string | undefined {
  if (identity?.trust === "trusted") return `${green("signed")} ${dim(`${identity.repository ?? ""}${identity.ref ? ` @ ${identity.ref}` : ""} · a trusted build`)}`;
  if (identity?.trust === "verified") {
    return `${yellow("signed")} ${dim(`${identity.repository ?? ""}${identity.ref ? ` @ ${identity.ref}` : ""} · not a build this organization lists as trusted`)}`;
  }
  if (identity?.rejected) return `${red("build token refused")} ${dim(identity.rejected)}`;
  return hint ? dim(`unsigned: ${hint}`) : undefined;
}

/** CI providers all expose these; reading them means a pipeline needs no extra configuration. */
function inferProject(projectRoot: string): string {
  const fromCi = process.env["GITHUB_REPOSITORY"] ?? process.env["CI_PROJECT_PATH"] ?? process.env["BUILD_REPOSITORY_NAME"];
  if (fromCi) return fromCi;
  return projectRoot.split("/").filter(Boolean).pop() ?? "default";
}

function inferRef(): string | undefined {
  return process.env["GITHUB_REF_NAME"] ?? process.env["CI_COMMIT_REF_NAME"] ?? undefined;
}

function inferCommit(): string | undefined {
  return process.env["GITHUB_SHA"] ?? process.env["CI_COMMIT_SHA"] ?? undefined;
}

export async function runPush(options: PushOptions): Promise<ExitCode> {
  const apiUrl = (options.apiUrl ?? process.env["NULLADRIFT_API_URL"] ?? "").replace(/\/+$/, "");
  const token = options.token ?? process.env["NULLADRIFT_TOKEN"] ?? "";
  if (!apiUrl || !token) {
    /*
     * Name the one that is missing. Both were reported as "needs a control plane to push to",
     * so supplying the URL and forgetting the token produced a message about the URL, which is
     * the part that was already correct.
     */
    const missing = !apiUrl && !token ? "a control plane to push to, and a token" : !apiUrl ? "a control plane to push to" : "a collector token";
    process.stderr.write(
      [
        red(`push needs ${missing}.`),
        ...(!apiUrl ? [dim("  --api <url> or NULLADRIFT_API_URL")] : []),
        ...(!token ? [dim("  --token <token> or NULLADRIFT_TOKEN")] : []),
        "",
      ].join("\n"),
    );
    return EXIT_INCOMPLETE;
  }

  const result = await captureAll({
    projectRoot: options.projectRoot,
    configFiles: options.configFiles,
    timeoutMs: options.timeoutMs,
    provenance: options.provenance,
  });

  /*
   * Nothing to send, caught here rather than by the control plane.
   *
   * An empty reading is refused on arrival ("a reading has to contain at least one server or one
   * failure"), which is correct but useless to read: it describes the request body to somebody
   * who was only trying to audit a project, and never mentions that no client config was found
   * or where the collector looked. `init` has said both for as long as it has existed.
   *
   * Incomplete rather than clean, which is where this parts company with `init`. Init is a
   * person setting things up and being told they are in the wrong directory; push is a CI gate,
   * and a gate that passes because it found nothing to check is how a project quietly stops
   * being audited at all.
   */
  if (Object.keys(result.lock.subjects).length === 0 && result.unreachable.length === 0) {
    const looked =
      result.discovery.filesRead.length > 0
        ? result.discovery.filesRead.join(", ")
        : "no client config files exist for this project";
    process.stderr.write(`No MCP servers found, so there is nothing to push.\n${dim(`Looked in: ${looked}`)}\n`);
    return EXIT_INCOMPLETE;
  }

  const servers = Object.entries(result.lock.subjects).map(([name, entry]) => ({
    name,
    transport: entry.transport.type,
    protocolEra: entry.protocol.era,
    protocolVersion: entry.protocol.version,
    client: entry.source.client,
    sourceFile: entry.source.file,
    serverInfo: entry.serverInfo,
    digest: entry.digest,
    toolCount: entry.tools?.length ?? 0,
    resourceCount: entry.resources?.length ?? 0,
    promptCount: entry.prompts?.length ?? 0,
    surface: entry,
  }));

  const body = {
    project: options.project ?? inferProject(options.projectRoot),
    ref: options.ref ?? inferRef(),
    commit: options.commit ?? inferCommit(),
    context: options.watch
      ? "watch"
      : process.env["CI"] !== undefined && process.env["CI"] !== "false"
        ? "ci"
        : "local",
    collectorVersion: VERSION,
    servers,
    unreachable: result.unreachable.map((failure) => ({ server: failure.server, reason: failure.reason })),
  };

  /*
   * The collector token says which organization this is; the build token says which build. Asked
   * for after the capture rather than before, because GitHub's tokens live for minutes and a slow
   * server could otherwise outlast one.
   */
  const build = await acquireBuildToken();
  const buildToken = build && "token" in build ? build.token : undefined;

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/v1/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(buildToken ? { [BUILD_TOKEN_HEADER]: buildToken } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    // A control plane that cannot be reached is an audit that did not happen, which is a 2 for
    // the same reason an unreachable server is.
    process.stderr.write(`${red("could not reach the control plane:")} ${(error as Error).message}\n`);
    return EXIT_INCOMPLETE;
  }

  if (!response.ok) {
    const refusal = describeRefusal(response.status, await response.text());
    /*
     * A plan limit is yellow, not red. It is an administrative fact rather than a failure, and
     * colouring it like a crash is what makes somebody chase a bug that is not there. The exit
     * code is still incomplete: the reading did not land, so this build cannot claim it looked.
     */
    process.stderr.write(`${refusal.planLimit ? yellow("plan limit:") : red("push failed:")} ${refusal.text}\n`);
    return EXIT_INCOMPLETE;
  }

  const verdict = (await response.json()) as IngestResponseBody;
  const lines: string[] = [""];
  const mark = verdict.verdict === "clean" ? green("✓") : verdict.verdict === "drift" ? yellow("!") : red("✗");
  lines.push(`${mark} ${bold(verdict.verdict)} ${dim(`· ${servers.length} server(s) · reading ${verdict.readingId.slice(0, 8)}`)}`);
  const identity = describeIdentity(verdict.identity, build && "hint" in build ? build.hint : undefined);
  if (identity) lines.push(`  ${identity}`);

  for (const change of verdict.changes) {
    lines.push(`  ${change.severity === "high" ? red("●") : change.severity === "medium" ? yellow("●") : dim("●")} ${bold(change.server)}${change.member ? dim(`/${change.member}`) : ""}  ${change.summary}`);
  }
  for (const reason of verdict.decision.reasons) {
    lines.push(`  ${red("blocked")} ${dim(reason.code)}  ${reason.message}`);
  }
  if (verdict.verdict !== "clean") lines.push("", dim(`Review it at ${verdict.url}`));
  lines.push("");
  process.stdout.write(lines.join("\n"));

  // The server's answer, not ours.
  return verdict.exitCode === 0 ? EXIT_CLEAN : verdict.exitCode === 1 ? EXIT_DRIFT : EXIT_INCOMPLETE;
}
