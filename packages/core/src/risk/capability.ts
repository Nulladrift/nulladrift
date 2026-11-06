/**
 * What a server could do to you, derived from what it declares.
 *
 * This answers one question and refuses another. It answers *what could this tool do if the
 * model decides to use it*, from the tool's name, its argument names and its schema shape. It
 * does not answer *is this tool malicious*, which is a judgement, needs a corpus, and would make
 * a verdict depend on something other than the bytes on the wire.
 *
 * The distinction matters because it is the same one the severity table already makes: rank by
 * shape, never by intent. A tool named `run_command` taking a `command` argument is arbitrary
 * execution whatever its description claims, and that is a fact about the declaration rather
 * than an opinion about the author.
 *
 * Nothing here is stored in the lockfile. Capabilities are derived from the schemas that *are*
 * stored, so sharpening a pattern re-reads existing locks instead of showing every user a wave
 * of drift that no server caused.
 */

/** Ordered worst-first; the order is the comparison. */
export const CAPABILITY_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type CapabilitySeverity = (typeof CAPABILITY_SEVERITIES)[number];

export const CAPABILITY_KINDS = [
  "process-exec",
  "code-eval",
  "credential-access",
  "file-write",
  "network-egress",
  "database",
  "privilege",
  "agent-control",
  "env-access",
  "file-read",
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export interface Capability {
  kind: CapabilityKind;
  severity: CapabilitySeverity;
  /** Where it was seen: `name`, or `arg:<argument>`. Shown so a finding can be checked. */
  evidence: string;
}

interface Rule {
  kind: CapabilityKind;
  severity: CapabilitySeverity;
  /** Matched against the tool name, with separators normalised to `_`. */
  name?: RegExp;
  /** Matched against each top-level argument name, normalised the same way. */
  arg?: RegExp;
}

/*
 * Deliberately narrow. A pattern that fires on `get_user` because it contains "user" teaches
 * people to ignore the output, and an ignored signal is worse than none: it spends the attention
 * the real findings need.
 */
const RULES: Rule[] = [
  { kind: "process-exec", severity: "critical", name: /(^|_)(exec|execute|spawn|shell|bash|sh|cmd|command|run_command|terminal|subprocess)(_|$)/, arg: /(^|_)(command|cmd|argv|shell|exec|script)(_|$)/ },
  // `source` is deliberately absent: in `copy_file(source, destination)` it is a path, and
  // labelling a file copy as arbitrary code execution at CRITICAL is the false positive that
  // teaches people to stop reading the line. `code` has to be the whole argument name for the
  // same reason -- a crawl of 468 published tools flagged `location_code` as arbitrary code
  // execution, and `country_code`, `status_code` and `zip_code` are all waiting behind it.
  { kind: "code-eval", severity: "critical", name: /(^|_)(eval|evaluate|run_code|exec_code|interpret|compile)(_|$)/, arg: /^code$|(^|_)(source_code|code_to_run|js_code|python_code|expression|program|snippet)(_|$)/ },
  { kind: "credential-access", severity: "critical", name: /(^|_)(secret|secrets|credential|credentials|token|keychain|vault|password)(_|$)/, arg: /(^|_)(secret|credential|password|private_key|api_key|access_token)(_|$)/ },
  { kind: "file-write", severity: "high", name: /(^|_)(write|create_file|put_file|save|delete|remove|unlink|rename|move|copy|chmod|mkdir|rmdir|edit)(_|$)/, arg: /(^|_)(contents|content|data|destination|dest_path|target_path)(_|$)/ },
  { kind: "network-egress", severity: "high", name: /(^|_)(fetch|request|http|curl|download|upload|post|webhook|navigate|browse|send)(_|$)/, arg: /(^|_)(url|uri|endpoint|host|hostname|webhook|callback)(_|$)/ },
  // Narrowed to things that are actually SQL-shaped. `query`, `select` and `update` on their
  // own matched `simulate-research-query`, `browser_select_option` and `trigger-resource-update`,
  // none of which is a database.
  { kind: "database", severity: "high", name: /(^|_)(sql|execute_sql|run_sql|query_db|db_query|migrate)(_|$)/, arg: /(^|_)(sql|statement|dsn|connection_string)(_|$)/ },
  { kind: "privilege", severity: "high", name: /(^|_)(sudo|root|admin|grant|revoke|permission|permissions|acl|policy)(_|$)/, arg: /(^|_)(role|scope|scopes|permission|permissions|privilege)(_|$)/ },
  { kind: "agent-control", severity: "high", name: /(^|_)(prompt|system_prompt|instruction|instructions|memory|context|persona)(_|$)/, arg: /(^|_)(system_prompt|instruction|instructions|persona)(_|$)/ },
  { kind: "env-access", severity: "medium", name: /(^|_)(env|environment|getenv|setenv|config|settings)(_|$)/, arg: /(^|_)(env|environment|env_var)(_|$)/ },
  { kind: "file-read", severity: "low", name: /(^|_)(read|read_file|cat|open|load|list_directory|ls|glob|search_files)(_|$)/, arg: /(^|_)(path|file|filename|filepath|directory|dir)(_|$)/ },
];

/*
 * Cyrillic and Greek letters that are drawn like Latin ones. `run_comm\u0430nd` reads as
 * `run_command` to a person and matched nothing at all, so a single substituted character
 * bought a tool complete invisibility to a classifier whose whole job is reading names.
 * Folding them is the difference between a check and a formality.
 */
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0441": "c", "\u0440": "p", "\u0445": "x",
  "\u0443": "y", "\u0456": "i", "\u0458": "j", "\u04BB": "h", "\u0501": "d", "\u051B": "q",
  "\u03BF": "o", "\u03B1": "a", "\u03B5": "e", "\u03BD": "v", "\u03C1": "p", "\u03C5": "u",
  "\u0131": "i", "\u1E9E": "s",
};

/** Built from the map above, so the pattern and the replacements cannot drift apart. */
const CONFUSABLE_PATTERN = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/** `browser.take-screenshot` and `browser_take_screenshot` are the same shape. */
function normalize(identifier: string): string {
  return identifier
    .toLowerCase()
    .replace(CONFUSABLE_PATTERN, (character) => CONFUSABLES[character] ?? character)
    .replace(/[-.\s/]+/g, "_");
}

/*
 * Nested properties count. `tool({ opts: { command } })` is the same capability as
 * `tool({ command })`, and only the top level was examined, so one wrapping object hid it.
 * Depth is bounded because a schema is attacker-supplied and need not terminate.
 */
function argumentNames(inputSchema: unknown, depth = 0): string[] {
  if (depth > 6 || typeof inputSchema !== "object" || inputSchema === null) return [];
  const node = inputSchema as { properties?: unknown; items?: unknown };
  const names: string[] = [];
  const properties = node.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      names.push(name);
      names.push(...argumentNames(child, depth + 1));
    }
  }
  if (node.items !== undefined) names.push(...argumentNames(node.items, depth + 1));
  return names;
}

/**
 * The capabilities one tool declares. Worst first, one entry per kind: a tool matching
 * `process-exec` by both its name and an argument is not twice as dangerous.
 */
export function toolCapabilities(tool: { name?: string; inputSchema?: unknown }): Capability[] {
  const name = normalize(tool.name ?? "");
  const args = argumentNames(tool.inputSchema).map((argument) => [argument, normalize(argument)] as const);
  const found = new Map<CapabilityKind, Capability>();

  for (const rule of RULES) {
    if (found.has(rule.kind)) continue;
    if (rule.name?.test(name)) {
      found.set(rule.kind, { kind: rule.kind, severity: rule.severity, evidence: "name" });
      continue;
    }
    const hit = rule.arg ? args.find(([, normalized]) => rule.arg?.test(normalized)) : undefined;
    if (hit) found.set(rule.kind, { kind: rule.kind, severity: rule.severity, evidence: `arg:${hit[0]}` });
  }

  return [...found.values()].sort(
    (a, b) => CAPABILITY_SEVERITIES.indexOf(a.severity) - CAPABILITY_SEVERITIES.indexOf(b.severity) || a.kind.localeCompare(b.kind),
  );
}

/** Every capability a set of tools declares between them, with the tools that declare each. */
export function surfaceCapabilities(tools: ReadonlyArray<{ name?: string; inputSchema?: unknown }>): Array<Capability & { tools: string[] }> {
  const byKind = new Map<CapabilityKind, Capability & { tools: string[] }>();
  for (const tool of tools) {
    for (const capability of toolCapabilities(tool)) {
      const existing = byKind.get(capability.kind);
      if (existing) existing.tools.push(tool.name ?? "?");
      else byKind.set(capability.kind, { ...capability, tools: [tool.name ?? "?"] });
    }
  }
  return [...byKind.values()].sort(
    (a, b) => CAPABILITY_SEVERITIES.indexOf(a.severity) - CAPABILITY_SEVERITIES.indexOf(b.severity) || a.kind.localeCompare(b.kind),
  );
}
