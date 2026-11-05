/** `nulladrift telemetry <on|off|status>`, and the one-time offer shown after `init`. */
import { createInterface } from "node:readline/promises";
import { EXIT_CLEAN, type ExitCode } from "../lib/exit";
import { bold, dim, green } from "../lib/ui";
import { telemetryEndpoint } from "../lib/meta";
import { buildPayload, clearPreference, describePayload, ID_ROTATION_MS, isCi, readConfig, readPreference, writePreference } from "../telemetry";

const ROTATION_DAYS = Math.round(ID_ROTATION_MS / (24 * 60 * 60 * 1_000));

const EXAMPLE = { changes: [], lockPath: "mcp.lock", serversChecked: 7, unreachable: [] };

/**
 * The sample uses the real install id when there is one, so the prompt and `status` show the
 * actual value rather than a reassuring placeholder.
 */
async function samplePayload(): Promise<string> {
  const { installId } = await readConfig();
  return describePayload(buildPayload(EXAMPLE, [], installId ?? "«minted when the first report is sent»"));
}

function privacyNotes(): string[] {
  return [
    dim(`It goes to ${telemetryEndpoint() ?? "(no collector configured)"}. No names, no URLs, no schemas, no digests.`),
    dim(`The install id is random, generated on this machine, derived from nothing about you, and`),
    dim(`rotates every ${ROTATION_DAYS} days. It exists so reports can be grouped -- without it the numbers are`),
    dim("dominated by whoever runs CI most often. A report is sent only when the picture changes,"),
    dim("not on every run. `nulladrift telemetry off` deletes the id along with the preference."),
  ];
}

/**
 * Asked once, after a successful `init`, and only on an interactive terminal. Never in CI:
 * silence from a machine is not consent, and a CI job cannot answer anyway.
 */
export async function maybeOfferTelemetry(): Promise<void> {
  // Nothing to ask for while there is nowhere to send it.
  if (telemetryEndpoint() === undefined) return;
  if (isCi() || process.stdin.isTTY !== true || process.stdout.isTTY !== true) return;
  if ((await readPreference()) !== undefined) return;

  process.stdout.write(
    [
      "",
      bold("One question, asked once."),
      "Nobody knows how often MCP tool definitions actually drift. If the answer is",
      '"almost never", this tool should not exist, and we would like to find that out.',
      "",
      dim("nulladrift can send anonymous counts after a check. In full, this is everything it would send:"),
      "",
      dim(await samplePayload()),
      "",
      ...privacyNotes(),
      "",
    ].join("\n"),
  );

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question("  Send anonymous drift counts? [y/N] ")).trim().toLowerCase();
    const enabled = answer === "y" || answer === "yes";
    await writePreference(enabled);
    process.stdout.write(`  ${enabled ? green("thank you, telemetry on") : dim("telemetry stays off")}\n\n`);
  } finally {
    readline.close();
  }
}

export async function runTelemetry(subcommand: string | undefined): Promise<ExitCode> {
  switch (subcommand) {
    case "on":
      await writePreference(true);
      process.stdout.write(
        telemetryEndpoint() === undefined
          ? `${green("telemetry on")}\n${dim("  No collector is configured in this build, so nothing will be sent until one is.")}\n`
          : `${green("telemetry on")}\n`,
      );
      return EXIT_CLEAN;
    case "off":
      await clearPreference();
      process.stdout.write(`${dim("telemetry off; stored preference and install id deleted")}\n`);
      return EXIT_CLEAN;
    case "status":
    case undefined: {
      const config = await readConfig();
      const issued = config.installIdIssuedAt ? new Date(config.installIdIssuedAt) : undefined;
      process.stdout.write(
        [
          `telemetry: ${config.telemetry === true ? green("on") : dim(config.telemetry === false ? "off" : "off (never asked)")}`,
          `endpoint:  ${telemetryEndpoint() ?? dim("none configured, nothing is sent")}`,
          `install id: ${config.installId ?? dim("none yet")}${issued ? dim(` (issued ${issued.toISOString().slice(0, 10)}, rotates every ${ROTATION_DAYS} days)`) : ""}`,
          "",
          "A report contains these fields and nothing else (counts here are illustrative):",
          await samplePayload(),
          "",
          ...privacyNotes(),
          "",
        ].join("\n"),
      );
      return EXIT_CLEAN;
    }
    default:
      process.stderr.write(`unknown telemetry subcommand "${subcommand}". Use on, off or status.\n`);
      return EXIT_CLEAN;
  }
}
