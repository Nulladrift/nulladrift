/**
 * `nulladrift push` -- capture the current surface and send it to a control plane, which decides
 * the verdict.
 *
 * The exit code comes from the server, not from here. That is the point of pushing rather than
 * checking: policy lives where the repository being audited cannot edit it, so a pull request
 * cannot widen what its own build is allowed to do.
 */
import { createHash } from "node:crypto";
import { captureAll } from "../audit";
import { EXIT_CLEAN, EXIT_DRIFT, EXIT_INCOMPLETE, type ExitCode } from "../lib/exit";
import { bold, dim, green, red, visibleControls, yellow } from "../lib/ui";
import { describeRefusal } from "../report/push-error";
import { redactedNotes } from "../report/redacted";
import { acquireBuildToken, acquireReadingToken, BUILD_TOKEN_HEADER, READING_TOKEN_HEADER, readingAudience, readingAudienceBase } from "../lib/build-token";
import { VERSION } from "../lib/version";
import { readingOrigin } from "../lib/origin";
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
    /** The provider signed this reading's contents too. Absent from a control plane before 0.7.0's. */
    boundToReading?: boolean;
    /** Why the token for this reading's contents was refused while the build's was accepted. */
    bindingRefused?: string;
  };
}

/** One line about which build the control plane believes sent this, or nothing worth a line. */
function describeIdentity(identity: IngestResponseBody["identity"], hint: string | undefined): string | undefined {
  // The control plane's words, escaped like any text this tool did not write itself.
  const shown = (text: string) => visibleControls(text);
  const where = shown(`${identity?.repository ?? ""}${identity?.ref ? ` @ ${identity.ref}` : ""}`);
  // Whether the signature covers what was sent, or only who sent it. Said only when the control plane said.
  const contents = identity?.boundToReading
    ? " · contents signed"
    : identity?.bindingRefused
      ? ` · contents not signed: ${shown(identity.bindingRefused)}`
      : "";
  if (identity?.trust === "trusted") return `${green("signed")} ${dim(`${where} · a trusted build${contents}`)}`;
  if (identity?.trust === "verified") {
    return `${yellow("signed")} ${dim(`${where} · not a build this organization lists as trusted${contents}`)}`;
  }
  if (identity?.rejected) return `${red("build token refused")} ${dim(shown(identity.rejected))}`;
  return hint ? dim(`unsigned: ${hint}`) : undefined;
}

/** Why an API address cannot be trusted with a token, or nothing if it can. Never echoes the address. */
export function refuseApiUrl(apiUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return "the control plane's address is not a URL.";
  }
  if (url.username || url.password) return "the control plane's address carries credentials. Pass the token with --token or NULLADRIFT_TOKEN instead.";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return undefined;
  return `the control plane has to be reached over https (http only on this machine), not ${url.protocol}`;
}

/** What an HTTP header value cannot hold. */
const UNSENDABLE = /[\r\n\0]/;

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

  /*
   * Where the token goes. Plain http sent the collector token and the CI's identity token in
   * clear; credentials in the URL were echoed back in an error; and a redirect to another host
   * carried the reading and the identity token with it (fetch drops `authorization` on a
   * cross-origin redirect but keeps every other header). So: https, or http to this machine for
   * a local control plane, no userinfo, and never a redirect.
   */
  const refusal = refuseApiUrl(apiUrl);
  if (refusal) {
    process.stderr.write(`${red("push refused:")} ${refusal}\n`);
    return EXIT_INCOMPLETE;
  }

  /*
   * A token with a line break in it cannot be sent as a header, and Node's refusal quotes the
   * whole header -- `Headers.append: "Bearer <token>" is an invalid header value` -- which was
   * printed to the job log as the reason. Refused here, by name.
   */
  if (UNSENDABLE.test(token)) {
    process.stderr.write(
      `${red("push refused:")} the collector token (${options.token !== undefined ? "--token" : "NULLADRIFT_TOKEN"}) contains a line break or NUL; a secret saved with a trailing newline is the usual cause\n`,
    );
    return EXIT_INCOMPLETE;
  }
  /*
   * On the command line, a token is in every process listing on the machine for as long as this
   * runs, and in shell history after. Not refused, since scripts depend on it; said.
   */
  if (options.token !== undefined) {
    process.stderr.write(`${yellow("note:")} --token is visible to other processes on this machine; prefer NULLADRIFT_TOKEN.\n`);
  }

  const result = await captureAll({
    projectRoot: options.projectRoot,
    configFiles: options.configFiles,
    timeoutMs: options.timeoutMs,
    provenance: options.provenance,
    userConfigs: options.userConfigs,
  });
  // What is sent is the locked transport, so a credential left out of the lock is left out of the reading too.
  for (const note of redactedNotes(result.lock)) process.stderr.write(`${yellow("note:")} ${note}\n`);

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

  // The control plane's own limits, checked here so a bad flag is named rather than answered with a 400.
  for (const [flag, value, max] of [
    ["--project", options.project, 200],
    ["--ref", options.ref, 200],
    ["--commit", options.commit, 100],
  ] as const) {
    const control = value !== undefined && [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
    if (value !== undefined && (value.trim() === "" || value.length > max || control)) {
      process.stderr.write(`${red(`${flag} has to be 1 to ${max} characters, with no control characters.`)}\n`);
      return EXIT_INCOMPLETE;
    }
  }
  const origin = readingOrigin(options.projectRoot, { project: options.project, ref: options.ref, commit: options.commit });
  /*
   * Said before sending, because this is the case that made two projects of one repository: a
   * laptop with no git remote named it after the folder, and CI named it after the repository.
   */
  if (origin.projectFrom === "folder") {
    process.stderr.write(
      `${yellow("note:")} reporting as project "${visibleControls(origin.project)}", this folder's name: no --project, CI variable or git remote names it. Pass --project so every push names it the same way.\n`,
    );
  }
  const body = {
    project: origin.project,
    ref: origin.ref,
    commit: origin.commit,
    context: options.watch
      ? "watch"
      : process.env["CI"] !== undefined && process.env["CI"] !== "false"
        ? "ci"
        : "local",
    collectorVersion: VERSION,
    servers,
    // The error, not the server's stderr: stderr is where a server prints its tokens and paths, and
    // this leaves the machine. The full reason is still printed locally.
    unreachable: result.unreachable.map((failure) => ({ server: failure.server, reason: failure.reason.split("\n  server stderr:")[0] ?? failure.reason })),
  };

  /*
   * The collector token says which organization this is; the build token says which build. Asked
   * for after the capture rather than before, because GitHub's tokens live for minutes and a slow
   * server could otherwise outlast one.
   */
  /*
   * The body is serialised once, and those exact bytes are both hashed and sent: the control
   * plane hashes what arrives before it parses anything, so a second serialisation that happened
   * to order or space things differently would be a different reading.
   */
  const payload = JSON.stringify(body);
  const digest = createHash("sha256").update(payload).digest("hex");
  const [build, reading] = await Promise.all([
    acquireBuildToken(),
    acquireReadingToken(readingAudience(readingAudienceBase(apiUrl), digest)),
  ]);
  const sendable = (candidate: string | undefined, what: string): string | undefined => {
    if (candidate === undefined || !UNSENDABLE.test(candidate)) return candidate;
    process.stderr.write(`${yellow("note:")} ${what} contains a line break or NUL, so it was left out; the reading goes unsigned.\n`);
    return undefined;
  };
  const buildToken = sendable(build && "token" in build ? build.token : undefined, "the identity token (NULLADRIFT_ID_TOKEN)");
  const readingToken = sendable(reading && "token" in reading ? reading.token : undefined, "the reading token");

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/v1/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(buildToken ? { [BUILD_TOKEN_HEADER]: buildToken } : {}),
        ...(readingToken ? { [READING_TOKEN_HEADER]: readingToken } : {}),
      },
      body: payload,
      // A redirect would carry the reading and the identity token to wherever it points.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    // A control plane that cannot be reached is an audit that did not happen, which is a 2 for
    // the same reason an unreachable server is.
    // Whatever the error quotes, none of the three credentials in the request goes to the log.
    let message = (error as Error).message;
    for (const secret of [token, buildToken, readingToken]) if (secret) message = message.split(secret).join("[redacted]");
    process.stderr.write(`${red("could not reach the control plane:")} ${message}\n`);
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
  /*
   * Everything below is the control plane's answer, and most of it quotes the audited server:
   * tool names, summaries. Escaped the way the local report escapes them, whatever the control
   * plane did or did not do first.
   */
  const shown = (text: unknown) => visibleControls(String(text ?? ""));
  lines.push(`${mark} ${bold(shown(verdict.verdict))} ${dim(`· ${shown(origin.project)} · ${servers.length} server(s) · reading ${shown(verdict.readingId).slice(0, 8)}`)}`);
  // Where the record says this came from, so a reading with neither is noticed here and not in an audit.
  if (origin.ref || origin.commit) lines.push(`  ${dim(`at ${shown(origin.ref ?? "a detached commit")}${origin.commit ? ` @ ${shown(origin.commit).slice(0, 7)}` : ""}`)}`);
  const identity = describeIdentity(verdict.identity, build && "hint" in build ? build.hint : undefined);
  if (identity) lines.push(`  ${identity}`);

  for (const change of verdict.changes) {
    lines.push(`  ${change.severity === "high" ? red("●") : change.severity === "medium" ? yellow("●") : dim("●")} ${bold(shown(change.server))}${change.member ? dim(`/${shown(change.member)}`) : ""}  ${shown(change.summary)}`);
  }
  for (const reason of verdict.decision.reasons) {
    lines.push(`  ${red("blocked")} ${dim(shown(reason.code))}  ${shown(reason.message)}`);
  }
  if (verdict.verdict !== "clean") lines.push("", dim(`Review it at ${shown(verdict.url)}`));
  lines.push("");
  process.stdout.write(lines.join("\n"));

  /*
   * Said here whatever the control plane decided. A server that could not be read was sent and
   * never mentioned, so under a policy that lets an unreachable server warn, the build passed with
   * "clean" and nothing at all said one of its servers had not been looked at. Found by pushing a
   * server that would not start.
   */
  if (result.unreachable.length > 0) {
    process.stderr.write(
      `${yellow("not read:")} ${result.unreachable.map((failure) => visibleControls(failure.server)).join(", ")} could not be reached, so ${
        result.unreachable.length === 1 ? "it was" : "they were"
      } not audited. Whether that fails the build is the control plane's policy.\n`,
    );
  }

  /*
   * A reading pushed from a surface only partly read is sent, so the control plane has what was
   * seen, and is not called finished here: the same exit 2 `check` gives it, unless allowed.
   */
  if (result.partial.length > 0 && options.allowPartial !== true) {
    process.stderr.write(
      `${yellow("incomplete:")} ${result.partial.map((entry) => visibleControls(entry.server)).join(", ")} could not be read in full. Pass --allow-partial to accept that.\n`,
    );
    return EXIT_INCOMPLETE;
  }

  // The server's answer, not ours.
  return verdict.exitCode === 0 ? EXIT_CLEAN : verdict.exitCode === 1 ? EXIT_DRIFT : EXIT_INCOMPLETE;
}
