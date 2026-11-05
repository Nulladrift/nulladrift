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

const RULE_HELP: Partial<Record<ChangeKind, string>> = {
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

export function renderSarifReport(report: AuditReport): string {
  const used = [...new Set(report.changes.map((change) => change.kind))].sort();

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
            rules: (used.length > 0 ? used : CHANGE_KINDS.slice(0, 0)).map((kind) => ({
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
          },
        },
        results: report.changes.map((change) => ({
          ruleId: change.kind,
          level: LEVEL[change.severity],
          message: { text: change.member ? `${change.server} › ${change.member}: ${change.summary}` : `${change.server}: ${change.summary}` },
          locations: [
            {
              physicalLocation: { artifactLocation: { uri: report.lockPath } },
              logicalLocations: [{ name: change.member ?? change.server, fullyQualifiedName: change.member ? `${change.server}/${change.member}` : change.server, kind: "member" }],
            },
          ],
          partialFingerprints: { "mcpAuditChange/v1": fingerprint(change) },
        })),
      },
    ],
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}
