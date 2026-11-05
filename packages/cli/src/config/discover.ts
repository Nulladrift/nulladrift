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
  /** Names defined more than once; the first definition won. */
  shadowed: Array<{ name: string; keptFrom: string; alsoIn: string }>;
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
  if (transport.type !== "stdio" || transport.cwd === undefined || isAbsolute(transport.cwd)) return server;
  return { ...server, transport: { ...transport, cwd: resolve(projectRoot, transport.cwd) } };
}

export async function discoverServers(projectRoot: string, extraFiles: string[] = []): Promise<Discovery> {
  const context: ExpandContext = { workspaceFolder: projectRoot, env: process.env };

  const files: ConfigFile[] = [
    ...extraFiles.map((path): ConfigFile => ({ client: "generic", path: resolve(projectRoot, path) })),
    ...candidateConfigFiles(projectRoot),
  ];

  const byName = new Map<string, { server: ConfiguredServer; from: string }>();
  const skipped: UnsupportedServerError[] = [];
  const filesRead: string[] = [];
  const shadowed: Discovery["shadowed"] = [];
  const problems: Discovery["problems"] = [];

  for (const file of files) {
    const read = await readJsonIfPresent(file.path);
    if (!read.present) continue;
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
      const existing = byName.get(server.name);
      if (existing) {
        shadowed.push({ name: server.name, keptFrom: existing.from, alsoIn: source.file });
        continue;
      }
      byName.set(server.name, { server, from: source.file });
    }
  }

  return {
    servers: [...byName.values()].map((entry) => entry.server).sort((a, b) => a.name.localeCompare(b.name)),
    skipped,
    filesRead,
    shadowed,
    problems,
  };
}
