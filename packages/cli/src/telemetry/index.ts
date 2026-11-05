/**
 * Opt-in, anonymous drift counts.
 *
 * Nobody knows how often MCP tool definitions drift in practice, and that number decides whether
 * this tool should exist. It is off unless the user turns it on, the prompt happens once and
 * only on an interactive terminal, and the payload is printed before the question is asked.
 *
 * Two properties are load-bearing, and both exist because the first design had neither:
 *
 *  - **One report per state change.** `check` runs on every CI build, and an unresolved drift
 *    produces the same diff until somebody accepts it. Sending on every run meant a single
 *    unfixed drift in an hourly job contributed 168 reports a week, inflating the numerator by
 *    how long a team took to respond. A report now goes out only when the picture changes.
 *  - **A rotating install id.** Without one, reports cannot be grouped, so the denominator is
 *    whichever installation runs CI most often and the resulting rate means nothing. The id is
 *    generated locally, never derived from anything about the machine or the user, and rotates
 *    every thirty days so a series cannot be followed indefinitely.
 *
 * What is never sent: server names, URLs, commands, tool names, descriptions, schemas, or any
 * digest of them. Digests are excluded deliberately -- a hash of a tool description is a
 * fingerprint that can be matched against any public server, which would make a report
 * re-identifiable by whoever holds it.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Change } from "../diff/types";
import { telemetryEndpoint } from "../lib/meta";
import { VERSION } from "../lib/version";
import type { AuditReport } from "../report/types";

export const PAYLOAD_SCHEMA = 2;
const SEND_TIMEOUT_MS = 2_000;

/**
 * Thirty days. Long enough to answer "what fraction of installations saw drift this month",
 * short enough that a series cannot be followed across quarters.
 */
export const ID_ROTATION_MS = 30 * 24 * 60 * 60 * 1_000;

export function configPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "nulladrift", "config.json");
}

export interface StoredConfig {
  telemetry?: boolean;
  installId?: string;
  installIdIssuedAt?: string;
  /** Hash of the last report actually delivered, so an unchanged picture is not resent. */
  lastReportHash?: string;
}

export interface TelemetryPayload {
  schema: typeof PAYLOAD_SCHEMA;
  installId: string;
  runId: string;
  auditVersion: string;
  context: "ci" | "local";
  serverCount: number;
  driftedServerCount: number;
  changes: Array<{ kind: string; count: number }>;
}

export function isCi(): boolean {
  return process.env["CI"] !== undefined && process.env["CI"] !== "false";
}

export async function readConfig(): Promise<StoredConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

async function writeConfig(patch: StoredConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...(await readConfig()), ...patch }, null, 2)}\n`, "utf8");
}

export async function readPreference(): Promise<boolean | undefined> {
  const { telemetry } = await readConfig();
  return typeof telemetry === "boolean" ? telemetry : undefined;
}

export async function writePreference(enabled: boolean): Promise<void> {
  await writeConfig({ telemetry: enabled });
}

/**
 * Turning telemetry off deletes the whole file rather than recording a "no" we keep forever --
 * and with it the install id, so opting out is not merely a flag on a retained identifier.
 */
export async function clearPreference(): Promise<void> {
  await rm(configPath(), { force: true });
}

/** Returns the current install id, minting or rotating it as needed. */
export async function resolveInstallId(now = Date.now()): Promise<string> {
  const config = await readConfig();
  const issuedAt = config.installIdIssuedAt ? Date.parse(config.installIdIssuedAt) : Number.NaN;
  const fresh = config.installId !== undefined && Number.isFinite(issuedAt) && now - issuedAt < ID_ROTATION_MS;
  if (fresh && config.installId !== undefined) return config.installId;

  const installId = randomUUID();
  await writeConfig({ installId, installIdIssuedAt: new Date(now).toISOString(), lastReportHash: undefined });
  return installId;
}

export function buildPayload(report: AuditReport, changes: Change[], installId: string): TelemetryPayload {
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);

  return {
    schema: PAYLOAD_SCHEMA,
    installId,
    // Distinguishes two runs from the same installation; not stored, and not an identifier.
    runId: randomUUID(),
    auditVersion: VERSION,
    context: isCi() ? "ci" : "local",
    serverCount: report.serversChecked,
    driftedServerCount: new Set(changes.map((change) => change.server)).size,
    changes: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => ({ kind, count })),
  };
}

/**
 * Identity of the *picture*, not of the run. Excludes `runId` and `installId` so that the same
 * findings on the same installation hash alike, and includes `auditVersion` so that an upgrade
 * which classifies a change differently is reported once.
 */
export function reportHash(payload: TelemetryPayload): string {
  const { schema, auditVersion, context, serverCount, driftedServerCount, changes } = payload;
  return createHash("sha256").update(JSON.stringify({ schema, auditVersion, context, serverCount, driftedServerCount, changes })).digest("hex");
}

/** Never throws and never affects the exit code: a failed report is not the user's problem. */
export async function send(payload: TelemetryPayload): Promise<boolean> {
  const endpoint = telemetryEndpoint();
  if (endpoint === undefined) return false;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `nulladrift/${VERSION}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type ReportOutcome = "sent" | "unchanged" | "disabled" | "unavailable" | "failed";

/**
 * The whole flow, as `check` uses it. A clean run is reported too: knowing how long a surface
 * stayed stable is half of a drift rate, and the transition from drifted back to clean is how
 * long a team took to respond.
 */
export async function reportIfChanged(report: AuditReport, changes: Change[], now = Date.now()): Promise<ReportOutcome> {
  if ((await readPreference()) !== true) return "disabled";
  // No collector configured: do not mint an install id or touch state for a report nobody receives.
  if (telemetryEndpoint() === undefined) return "unavailable";

  const payload = buildPayload(report, changes, await resolveInstallId(now));
  const hash = reportHash(payload);
  if ((await readConfig()).lastReportHash === hash) return "unchanged";

  if (!(await send(payload))) return "failed";
  // Recorded only on success, so a dropped report is retried on the next run.
  await writeConfig({ lastReportHash: hash });
  return "sent";
}

export function describePayload(payload: TelemetryPayload): string {
  return JSON.stringify(payload, null, 2);
}
