#!/usr/bin/env node
/** `nulladrift` entry point: flag parsing and dispatch. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runCheck } from "./commands/check";
import { runInit } from "./commands/init";
import { runLogin, runLogout } from "./commands/login";
import { runPush } from "./commands/push";
import { runReview } from "./commands/review";
import { runTelemetry } from "./commands/telemetry";
import type { CommonOptions } from "./commands/options";
import { DEFAULT_LOCK_FILENAME, LockfileError } from "./lock/io";
import { EXIT_CLEAN, EXIT_INCOMPLETE, type ExitCode } from "./lib/exit";
import { DEFAULT_TIMEOUT_MS } from "./mcp/connect";
import { bold, dim, red } from "./lib/ui";
import { VERSION } from "./lib/version";

const HELP = `${bold("nulladrift")} ${VERSION} - pin what your MCP servers are allowed to do

${bold("Usage")}
  nulladrift init                 discover servers, capture capabilities, write the lock
  nulladrift check                re-capture, diff against the lock, fail on drift
  nulladrift review               show what changed and accept it into the lock
  nulladrift push                 send the surface to a control plane, which decides the verdict
  nulladrift login <server>       authorize a remote server once, in a browser
  nulladrift logout <server>      delete the stored credentials for a server
  nulladrift telemetry <on|off|status>

${bold("Options")}
  --lock <path>          lockfile to read or write (default: ./${DEFAULT_LOCK_FILENAME})
  --cwd <path>           project root to scan for client configs (default: current directory)
  --config <path>        audit this config file too; repeatable
  --timeout <ms>         per-server timeout (default: ${DEFAULT_TIMEOUT_MS})
  --allow-unreachable    a server that cannot be reached warns instead of failing
  --no-provenance        do not look up what each stdio server runs (air-gapped runs)
  --json                 machine-readable output (check)
  --sarif                SARIF 2.1.0 output (check)
  --sarif-steering       also emit steering passages as SARIF notes (off: an alert is a gate)
  --accept-all           accept every change without prompting (review)
  --force                re-pin over an existing lockfile, discarding it (init)
  --api <url>            control plane to push to (push; or NULLADRIFT_API_URL)
  --token <token>        collector token (push; or NULLADRIFT_TOKEN)
  --project <name>       project name to report under (push; inferred from CI otherwise)
  --watch                mark this as a scheduled reading rather than one a build asked for (push)
  --comment              post the findings on the pull request being reviewed (check; needs CI)
  -h, --help             this text
  -v, --version          print the version

${bold("Exit codes")}
  0  everything matches the lock
  1  drift detected
  2  the audit could not be completed (server unreachable, or config/lockfile unreadable)
     If both happen at once the code is 2: an incomplete audit cannot claim the drift it
     found is the only drift there is.
`;

async function main(): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lock: { type: "string" },
      cwd: { type: "string" },
      config: { type: "string", multiple: true },
      timeout: { type: "string" },
      "allow-unreachable": { type: "boolean", default: false },
      "no-provenance": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      sarif: { type: "boolean", default: false },
      "sarif-steering": { type: "boolean", default: false },
      "accept-all": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      api: { type: "string" },
      token: { type: "string" },
      project: { type: "string" },
      watch: { type: "boolean", default: false },
      comment: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_CLEAN;
  }
  const command = positionals[0];
  if (values.help || command === undefined || command === "help") {
    process.stdout.write(`${HELP}\n`);
    return command === undefined && !values.help ? EXIT_INCOMPLETE : EXIT_CLEAN;
  }

  if (values.json && values.sarif) {
    process.stderr.write(`${red("--json and --sarif are mutually exclusive.")}\n`);
    return EXIT_INCOMPLETE;
  }

  const timeoutMs = values.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number.parseInt(values.timeout, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write(`${red(`--timeout must be a positive number of milliseconds, got "${values.timeout}".`)}\n`);
    return EXIT_INCOMPLETE;
  }

  const projectRoot = resolve(values.cwd ?? process.cwd());
  const options: CommonOptions = {
    projectRoot,
    lockPath: resolve(projectRoot, values.lock ?? DEFAULT_LOCK_FILENAME),
    configFiles: values.config ?? [],
    timeoutMs,
    allowUnreachable: values["allow-unreachable"],
    format: values.sarif ? "sarif" : values.json ? "json" : "human",
    sarifSteering: values["sarif-steering"] === true,
    comment: values.comment,
    provenance: values["no-provenance"] !== true,
  };

  switch (command) {
    case "init":
      return runInit({ ...options, force: values.force });
    case "check":
      return runCheck(options);
    case "push":
      return runPush({ ...options, apiUrl: values.api, token: values.token, project: values.project, watch: values.watch });
    case "review":
      return runReview({ ...options, acceptAll: values["accept-all"] });
    case "login":
      return runLogin({ projectRoot, configFiles: options.configFiles, serverName: positionals[1] });
    case "logout":
      return runLogout({ projectRoot, configFiles: options.configFiles, serverName: positionals[1] });
    case "telemetry":
      return runTelemetry(positionals[1]);
    default:
      process.stderr.write(`${red(`unknown command "${command}".`)}\n${dim("Run `nulladrift --help`.")}\n`);
      return EXIT_INCOMPLETE;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
    /*
     * A stdio server that ignores being closed can hold the event loop open. The timer is
     * unref'd, so it never delays a clean exit, but it does fire if something is still hanging.
     */
    setTimeout(() => process.exit(code), 2_000).unref();
  })
  .catch((error: unknown) => {
    const message = error instanceof LockfileError ? error.message : ((error as Error).stack ?? String(error));
    process.stderr.write(`${red("nulladrift failed:")} ${message}\n`);
    process.exitCode = EXIT_INCOMPLETE;
  });
