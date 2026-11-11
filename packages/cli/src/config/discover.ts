/**
 * Finding the config files the project's clients already use, so that `init` needs no flags.
 *
 * Order matters: the same server name can appear in more than one file, and the first match
 * wins. The sequence runs most-specific to least -- a file committed to this repository beats a
 * personal one, and a project-scoped entry beats a global one -- which is the precedence the
 * clients themselves apply.
 */
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConfigFile, ConfiguredServer } from "./types";
import type { ParsedConfig, UnsupportedServerError } from "./parsers";
import { CLIENT_MAP_KEY, detectMapKey, parseClaudeJson, parseServerMap } from "./parsers";
import type { ExpandContext } from "./expand";

function claudeDesktopPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

export function candidateConfigFiles(projectRoot: string): ConfigFile[] {
  const home = homedir();
  const copilotHome = process.env["COPILOT_HOME"] ?? join(home, ".copilot");

  return [
    { client: "claude-code", path: join(projectRoot, ".mcp.json"), scope: "project" },
    { client: "vscode", path: join(projectRoot, ".vscode", "mcp.json"), scope: "project" },
    { client: "cursor", path: join(projectRoot, ".cursor", "mcp.json"), scope: "project" },
    { client: "claude-code", path: join(home, ".claude.json"), scope: "user" },
    { client: "cursor", path: join(home, ".cursor", "mcp.json"), scope: "user" },
    { client: "claude-desktop", path: claudeDesktopPath(), scope: "user" },
    { client: "windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), scope: "user" },
    { client: "copilot", path: join(copilotHome, "mcp-config.json"), scope: "user" },
  ];
}

/**
 * The path as written into the lock. Absolute machine paths differ per developer and would churn
 * the diff of a committed file, so they are reduced to a repo-relative path or a `~` form.
 */
export function portablePath(absolute: string, projectRoot: string): string {
  const fromProject = relative(projectRoot, absolute);
  if (!fromProject.startsWith("..") && !isAbsolute(fromProject)) return fromProject.split(sep).join("/");

  const fromHome = relative(homedir(), absolute);
  if (!fromHome.startsWith("..") && !isAbsolute(fromHome)) return `~/${fromHome.split(sep).join("/")}`;

  return absolute.split(sep).join("/");
}

export interface Discovery {
  servers: ConfiguredServer[];
  skipped: UnsupportedServerError[];
  /** Config files that existed and were read. */
  filesRead: string[];
  /**
   * Every path considered, whether or not it was there. `filesRead` holds only the files that
   * existed, so "No MCP servers found. Looked in: ~/.claude.json, ~/Library/.../claude_desktop"
   * was the whole report for a project with no config of its own -- giving no way to tell the
   * project had been searched at all. Somebody standing in a repository reads that and concludes
   * the tool does not look locally.
   */
  searched: string[];
  /**
   * User-level config files that exist and were left out, because `--user-configs` was not given.
   * They hold one person's servers, often with their keys and home paths, and the lock is a file
   * the whole team commits; so they are read only when asked for, and said to be there when not.
   */
  userConfigsSkipped: string[];
  /** Names defined more than once, identically each time; the first definition was used. */
  shadowed: Array<{ name: string; keptFrom: string; alsoIn: string }>;
  /**
   * Names defined more than once, differently. None of the definitions is in `servers`.
   *
   * Each client reads its own file -- VS Code `.vscode/mcp.json`, Cursor `.cursor/mcp.json` --
   * so a name defined three ways runs three ways, and auditing the first one vouched for two
   * definitions nobody looked at. A pull request that added `.vscode/mcp.json` with `demo` set to
   * `curl ... | sh` passed `check` against a lock that pinned the `.mcp.json` one. Which
   * definition a name means is the project's to settle, so none is audited until it does.
   */
  conflicts: Array<{ name: string; definitions: Array<{ file: string; server: ConfiguredServer }> }>;
  /** Files named explicitly that could not be understood. Never silently ignored. */
  problems: Array<{ file: string; reason: string }>;
}

type ReadResult = { present: false } | { present: true; ok: true; value: unknown } | { present: true; ok: false; reason: string };

async function readJsonIfPresent(path: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { present: false };
    if (code === "EACCES") return { present: true, ok: false, reason: "permission denied" };
    throw error;
  }
  try {
    return { present: true, ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    /*
     * A config file that exists but will not parse is reported, not skipped. Skipping it means
     * a project whose only `.mcp.json` has a trailing comma audits as "no servers found" and
     * exits 0 -- a pass earned by failing to read the question.
     */
    return { present: true, ok: false, reason: `not valid JSON: ${(error as Error).message}` };
  }
}

/**
 * A relative `cwd` in a config file means "relative to the project", not "relative to wherever
 * the auditor happened to be invoked".
 *
 * It was passed to the spawn verbatim, so Node resolved it against `process.cwd()`. Running from
 * the project root hid this; running from anywhere else, which is what `--cwd` and most CI
 * layouts do, silently started the server in the wrong directory and reported whatever it failed
 * to find there. Apache SkyWalking BanyanDB configures `"cwd": "."`, and every client that reads
 * that file resolves it against the file, so this matches them rather than inventing a meaning.
 */
function anchorCwd(server: ConfiguredServer, projectRoot: string): ConfiguredServer {
  const { transport } = server;
  if (transport.type !== "stdio") return server;
  /*
   * No `cwd` at all means the project too. It meant wherever the auditor was started, while what
   * the server runs was resolved against the project: `check --cwd proj` from the repository
   * root ran `<root>/server.mjs` and hashed `proj/server.mjs`, so the pinned file was not the one
   * that ran. The lock still records `cwd` only as the config writes it.
   */
  if (transport.cwd === undefined) return { ...server, transport: { ...transport, cwd: projectRoot } };
  if (isAbsolute(transport.cwd)) return server;
  return { ...server, transport: { ...transport, cwd: resolve(projectRoot, transport.cwd) } };
}

/**
 * What was looked at, and what was found there. The old message listed only the files that
 * existed, so a project with no config of its own reported two paths in the user's home
 * directory and nothing else -- no way to tell whether the project itself had been searched.
 */
export function describeSearch(searched: string[], filesRead: string[]): string {
  const read = new Set(filesRead);
  const lines = searched.map((path) => `  ${(read.has(path) ? "read" : "absent").padEnd(6)}  ${path}`);
  return lines.join("\n");
}

export async function discoverServers(
  projectRoot: string,
  extraFiles: string[] = [],
  options: { userConfigs?: boolean } = {},
): Promise<Discovery> {
  const context: ExpandContext = { workspaceFolder: projectRoot, env: process.env };

  /*
   * Project configs only, unless asked. User-level files (`~/.claude.json`, Claude Desktop,
   * Cursor, Windsurf, Copilot) describe one person's servers: pinning them wrote their arguments,
   * home paths and key names into the project's committed lock and into every reading pushed,
   * and a teammate or a CI runner without those files saw them as removed.
   */
  const candidates = candidateConfigFiles(projectRoot);
  const userFiles = candidates.filter((file) => file.scope === "user");
  const files: ConfigFile[] = [
    ...extraFiles.map((path): ConfigFile => ({ client: "generic", path: resolve(projectRoot, path) })),
    ...candidates.filter((file) => options.userConfigs === true || file.scope !== "user"),
  ];

  const byName = new Map<string, { server: ConfiguredServer; from: string }>();
  const skipped: UnsupportedServerError[] = [];
  const filesRead: string[] = [];
  const shadowed: Discovery["shadowed"] = [];
  const conflicting = new Map<string, Array<{ file: string; server: ConfiguredServer }>>();
  const problems: Discovery["problems"] = [];

  // A file named with --config was asked for by name. The candidate list is a guess and may
  // legitimately be absent; an explicit path that is not there is a mistake, and reporting
  // "no servers found, exit 0" for a mistyped --config is a silent pass over an unaudited project.
  const requested = new Set(files.filter((file) => file.client === "generic").map((file) => file.path));

  for (const file of files) {
    const read = await readJsonIfPresent(file.path);
    if (!read.present) {
      if (requested.has(file.path)) {
        problems.push({ file: portablePath(file.path, projectRoot), reason: "no such file; it was named with --config" });
      }
      continue;
    }
    if (!read.ok) {
      problems.push({ file: portablePath(file.path, projectRoot), reason: read.reason });
      continue;
    }
    const raw = read.value;
    filesRead.push(file.path);

    const source = { client: file.client, file: portablePath(file.path, projectRoot) };

    /*
     * A file named with --config could be in any client's format, so its key is sniffed rather
     * than assumed. Guessing wrong used to parse to zero servers and still exit 0 -- a silent
     * pass over a project nothing had actually audited.
     */
    let mapKey: "mcpServers" | "servers" | undefined = CLIENT_MAP_KEY[file.client];
    if (file.client === "generic") {
      mapKey = detectMapKey(raw);
      if (mapKey === undefined) {
        problems.push({ file: source.file, reason: "no `mcpServers` or `servers` object found; this does not look like an MCP client config" });
        continue;
      }
    }

    const parsed: ParsedConfig =
      file.client === "claude-code" && file.scope === "user"
        ? await parseClaudeJson(raw, projectRoot, source, context)
        : await parseServerMap(raw, mapKey, { ...source, scope: file.scope }, context);

    skipped.push(...parsed.skipped);
    for (const server of parsed.servers.map((entry) => anchorCwd(entry, projectRoot))) {
      const contested = conflicting.get(server.name);
      if (contested) {
        contested.push({ file: source.file, server });
        continue;
      }
      const existing = byName.get(server.name);
      if (existing) {
        if (sameDefinition(existing.server, server)) {
          shadowed.push({ name: server.name, keptFrom: existing.from, alsoIn: source.file });
          continue;
        }
        byName.delete(server.name);
        conflicting.set(server.name, [{ file: existing.from, server: existing.server }, { file: source.file, server }]);
        continue;
      }
      byName.set(server.name, { server, from: source.file });
    }
  }

  return {
    servers: [...byName.values()].map((entry) => entry.server).sort((a, b) => a.name.localeCompare(b.name)),
    skipped,
    filesRead,
    searched: files.map((file) => file.path),
    userConfigsSkipped:
      options.userConfigs === true
        ? []
        : (await Promise.all(userFiles.map(async (file) => ((await readJsonIfPresent(file.path)).present ? portablePath(file.path, projectRoot) : undefined)))).filter(
            (path): path is string => path !== undefined,
          ),
    shadowed,
    conflicts: [...conflicting].map(([name, definitions]) => ({ name, definitions })).sort((a, b) => a.name.localeCompare(b.name)),
    problems,
  };
}

/**
 * Whether two definitions start the same server the same way: what is run, with what arguments,
 * environment values and working directory, or which URL with which headers and OAuth settings.
 * Values, not names: two files that set `API_URL` to different hosts are two servers.
 */
export function sameDefinition(a: ConfiguredServer, b: ConfiguredServer): boolean {
  const essence = ({ transport }: ConfiguredServer): unknown =>
    transport.type === "stdio"
      ? { type: "stdio", command: transport.command, args: transport.args, env: sorted(transport.env), cwd: transport.cwd ?? null }
      : { type: transport.type, url: transport.url, headers: sorted(lowercased(transport.headers)), oauth: transport.oauth ? sorted({ ...transport.oauth }) : null };
  return JSON.stringify(essence(a)) === JSON.stringify(essence(b));
}

function sorted<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function lowercased(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}
