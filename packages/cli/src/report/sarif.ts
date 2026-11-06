import { isAbsolute, relative, sep } from "node:path";
/**
 * SARIF 2.1.0, so drift lands in GitHub code scanning or any other AppSec tool without anyone
 * writing an integration.
 *
 * Findings carry a `partialFingerprints` entry derived from the change's identity but not its
 * contents, so a finding that persists across runs is recognised as the same finding rather than
 * reopened each time, while a genuinely new change gets a new fingerprint.
 */
import { createHash } from "node:crypto";
import type { Change, ChangeKind, Severity } from "../diff/types";
import { CHANGE_KINDS, SEVERITY } from "../diff/types";
import { helpUriFor, publishedDocsUrl } from "../lib/meta";
import { VERSION } from "../lib/version";
import type { AuditReport } from "./types";

const LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  high: "error",
  medium: "warning",
  low: "note",
};

/**
 * Not a change kind: a standing rule about the surface, so it has no entry in the taxonomy and
 * cannot collide with one.
 */
const DENIED_RULE = "policy.capability.denied";

/**
 * Steering findings are omitted unless asked for, and the asking is a flag rather than the
 * default.
 *
 * A SARIF result becomes a code-scanning alert, and an alert is a gate wherever a team requires
 * zero open alerts. A regular expression over prose must not be able to acquire that power by
 * default: a server documenting "before using this tool, call authenticate first" would raise
 * one. Capability violations are the opposite case -- derived from schema shape, already fatal to
 * the build -- so they are always here.
 */
const STEERING_RULE = "steering.passage.arrived";

const RULE_HELP: Partial<Record<ChangeKind, string>> = {
  "tool.capability.gained":
    "A tool gained a capability it did not declare before, derived from its name, its argument names and the shape of its schema. The severity is the capability's, not the schema change's: gaining a `command` argument is not the same finding as gaining an optional string.",
  "tool.description.changed":
    "A tool description is injected into the model's context. A change here can carry instructions to the agent and should be read in full, not skimmed.",
  "server.instructions.changed":
    "The server's instructions string is placed in the model's system prompt by the client. Treat a change the way you would treat a change to prompt source.",
  "tool.behavior.escalated":
    "The tool now claims a power it did not claim when it was pinned. Annotation defaults are not neutral: removing readOnlyHint is an escalation.",
  "tool.input_schema.widened": "The tool accepts input it previously rejected, enlarging what the agent can be induced to send.",
  "tool.header_params.changed":
    "x-mcp-header mirrors an argument's value into an HTTP header, where proxies and other intermediaries can read it.",
  "server.transport.changed": "The configured name now points at a different command or URL. This is a different server, not a changed one.",
  "server.identity.changed": "The server reports a different identity or version than the one that was reviewed.",
};

function fingerprint(change: Change): string {
  return createHash("sha256").update(`${change.kind}\u0000${change.server}\u0000${change.member ?? ""}`).digest("hex").slice(0, 32);
}

/**
 * The lockfile's path as SARIF wants it: relative to the repository, with forward slashes.
 *
 * This emitted `report.lockPath` verbatim, which is absolute. GitHub code scanning resolves
 * `artifactLocation.uri` against the repository root, so an absolute path matched no file and
 * the alert arrived with nothing to click through to -- in a feature whose whole pitch is that
 * drift shows up in code scanning with no integration to write.
 */
function sarifUri(report: AuditReport): string {
  if (report.projectRoot === undefined) return report.lockPath;
  const rel = relative(report.projectRoot, report.lockPath);
  // A lock outside the project has no repository-relative form; absolute is the honest fallback.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return report.lockPath;
  return rel.split(sep).join("/");
}

export function renderSarifReport(report: AuditReport, options: { steering?: boolean } = {}): string {
  const used = [...new Set(report.changes.map((change) => change.kind))].sort();
  const violations = report.violations ?? [];
  const steering = options.steering ? (report.steering ?? []) : [];

  /*
   * One shape for all three sources. Without it the three `map`s infer three different literal
   * types for `level` and refuse to join.
   */
  interface SarifResult {
    ruleId: string;
    level: "error" | "warning" | "note";
    message: { text: string };
    locations: unknown[];
    partialFingerprints: Record<string, string>;
  }
  const at = (name: string, qualified: string): unknown[] => [
    {
      physicalLocation: { artifactLocation: { uri: sarifUri(report), uriBaseId: "%SRCROOT%" } },
      logicalLocations: [{ name, fullyQualifiedName: qualified, kind: "member" }],
    },
  ];

  const extraRules = [
    ...(violations.length > 0
      ? [{
          id: DENIED_RULE,
          name: "PolicyCapabilityDenied",
          shortDescription: { text: "A capability this project does not permit" },
          fullDescription: { text: "A pinned tool has a capability listed in policy.deniedCapabilities. Derived from the shape of the declaration, and not cleared by accepting the change." },
          defaultConfiguration: { level: "error" as const },
        }]
      : []),
    ...(steering.length > 0
      ? [{
          id: STEERING_RULE,
          name: "SteeringPassageArrived",
          shortDescription: { text: "Text that began addressing the model" },
          fullDescription: { text: "A passage a model is shown started reading as an instruction since this lock was approved. A signal to read, not a verdict: legitimate servers trip the same shape. It does not affect the exit code." },
          defaultConfiguration: { level: "note" as const },
        }]
      : []),
  ];

  const document = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "nulladrift",
            version: VERSION,
            ...(publishedDocsUrl() === undefined ? {} : { informationUri: publishedDocsUrl() }),
            rules: [
              ...(used.length > 0 ? used : CHANGE_KINDS.slice(0, 0)).map((kind) => ({
              id: kind,
              name: kind
                .split(/[._]/)
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(""),
              shortDescription: { text: `MCP capability drift: ${kind}` },
              fullDescription: { text: RULE_HELP[kind] ?? "The pinned MCP capability surface no longer matches what the server reports." },
              defaultConfiguration: { level: LEVEL[SEVERITY[kind]] },
              ...(helpUriFor("6-change-taxonomy") === undefined ? {} : { helpUri: helpUriFor("6-change-taxonomy") }),
            })),
            ...extraRules,
            ],
          },
        },
        results: [
          ...report.changes.map<SarifResult>((change) => ({
            ruleId: change.kind,
            level: LEVEL[change.severity],
            message: { text: change.member ? `${change.server} \u203a ${change.member}: ${change.summary}` : `${change.server}: ${change.summary}` },
            locations: at(change.member ?? change.server, change.member ? `${change.server}/${change.member}` : change.server),
            partialFingerprints: { "mcpAuditChange/v1": fingerprint(change) },
          })),
          ...violations.map<SarifResult>((violation) => ({
            ruleId: DENIED_RULE,
            level: "error",
            message: { text: `${violation.server} \u203a ${violation.tool}: ${violation.kind} is not permitted here (${violation.evidence})` },
            locations: at(violation.tool, `${violation.server}/${violation.tool}`),
            partialFingerprints: { "mcpAuditChange/v1": `${violation.server}/${violation.tool}/${violation.kind}` },
          })),
          ...steering.flatMap(({ server, signals }) =>
            signals.map<SarifResult>((signal) => ({
              ruleId: STEERING_RULE,
              level: "note",
              message: { text: `${server} \u203a ${signal.field}: ${signal.quote}` },
              locations: at(signal.field, `${server}/${signal.field}`),
              partialFingerprints: { "mcpAuditChange/v1": `${server}/${signal.field}/${signal.kind}` },
            })),
          ),
        ],
      },
    ],
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}
