/**
 * Reading the configuration formats that already exist.
 *
 * There is no cross-client standard -- the proposal for one is still a discussion thread -- so
 * this supports the shapes that ship: a `mcpServers` map (Claude Code, Claude Desktop, Cursor,
 * Copilot, Windsurf) and VS Code's `servers` map, which is the same idea under a different key
 * with a few extra fields.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ClientKind, LockedSource } from "../lock/types";
import type { ConfiguredServer, ConfiguredTransport } from "./types";
import type { ExpandContext } from "./expand";
import { expand } from "./expand";

/** Lenient on purpose: unknown keys are another client's extension, not our problem. */
const serverEntrySchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  envFile: z.string().optional(),
  headersHelper: z.string().optional(),
  oauth: z
    .looseObject({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      issuer: z.string().optional(),
      scope: z.string().optional(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
});

export type ServerEntry = z.infer<typeof serverEntrySchema>;

export class UnsupportedServerError extends Error {
  constructor(
    readonly serverName: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedServerError";
  }
}

function scalarsToStrings(record: Record<string, string | number | boolean | null> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    // VS Code uses `null` to mean "remove this variable", so it contributes no key.
    if (value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function refusedCredentials(name: string, refused: string[]): UnsupportedServerError {
  const names = [...new Set(refused)];
  return new UnsupportedServerError(
    name,
    `configuration uses ${names.join(", ")}, which ${names.length === 1 ? "holds" : "hold"} this run's own credentials (the CI job's ` +
      `token or identity, or Nulladrift's). They are never given to a server under audit. Give the server a credential of its own.`,
  );
}

function resolveTransport(name: string, entry: ServerEntry, context: ExpandContext): ConfiguredTransport {
  const unresolved: string[] = [];
  const refused: string[] = [];
  const take = (input: string): string => {
    const result = expand(input, context);
    unresolved.push(...result.unresolved);
    refused.push(...result.refused);
    return result.value;
  };

  const declared = entry.type === "streamable-http" ? "http" : entry.type;

  if (declared === "ws") {
    // No WebSocket transport exists in the current SDK, and the spec defines only stdio and
    // Streamable HTTP. Saying so beats a connection error that looks like the server is down.
    throw new UnsupportedServerError(name, "WebSocket transport is not supported by the MCP specification or the SDK");
  }

  let transport: ConfiguredTransport;
  if (declared === "http" || declared === "sse" || (declared === undefined && entry.url !== undefined)) {
    if (entry.url === undefined) throw new UnsupportedServerError(name, `transport "${declared}" needs a url`);
    const oauth = entry.oauth;
    transport = {
      type: declared === "sse" ? "sse" : "http",
      url: take(entry.url),
      asWritten: { url: String(entry.url) },
      headers: Object.fromEntries(Object.entries(scalarsToStrings(entry.headers)).map(([key, value]) => [key, take(value)])),
      ...(oauth === undefined
        ? {}
        : {
            oauth: {
              // Expanded here so a secret can live in the environment rather than the config file.
              clientId: oauth.clientId === undefined ? undefined : take(oauth.clientId),
              clientSecret: oauth.clientSecret === undefined ? undefined : take(oauth.clientSecret),
              issuer: oauth.issuer === undefined ? undefined : take(oauth.issuer),
              scope: oauth.scope ?? oauth.scopes?.join(" "),
            },
          }),
    };
  } else {
    if (entry.command === undefined) throw new UnsupportedServerError(name, "stdio server has no command");
    transport = {
      type: "stdio",
      command: take(entry.command),
      args: (entry.args ?? []).map((argument) => take(String(argument))),
      asWritten: {
        command: String(entry.command),
        args: (entry.args ?? []).map((argument) => String(argument)),
        ...(entry.cwd ? { cwd: String(entry.cwd) } : {}),
      },
      env: Object.fromEntries(Object.entries(scalarsToStrings(entry.env)).map(([key, value]) => [key, take(value)])),
      cwd: entry.cwd ? take(entry.cwd) : undefined,
    };
  }

  /*
   * A client secret goes to the authorization server the MCP server names in its metadata, unless
   * the client says which one it is for. A compromised server names its own and receives the
   * secret on the next run, in CI, where nobody is watching. So a secret without an issuer is
   * refused here, before anything connects, rather than sent and regretted.
   */
  if (transport.type !== "stdio" && transport.oauth?.clientSecret !== undefined && !transport.oauth.issuer) {
    throw new UnsupportedServerError(
      name,
      "oauth.clientSecret is set without oauth.issuer. Set oauth.issuer to the authorization server's issuer URL, " +
        "so the secret can only be sent there and not to an authorization server the MCP server chooses.",
    );
  }

  // Before anything connects: the server is never started with the run's credentials in reach.
  if (refused.length > 0) throw refusedCredentials(name, refused);

  if (unresolved.length > 0) {
    const names = [...new Set(unresolved)].join(", ");
    throw new UnsupportedServerError(
      name,
      `configuration contains placeholders this tool cannot resolve: ${names}. ` +
        `Editor-supplied values (\${input:...}) and unset variables have to be present in the environment when the audit runs, ` +
        `because a server may serve a different tool list without them.`,
    );
  }
  return transport;
}

/**
 * Which key a config file keeps its servers under. VS Code uses `servers`; everyone else uses
 * `mcpServers`. A file named explicitly with `--config` could be either, and guessing wrong
 * produced an empty audit that still exited 0 -- a silent pass over an unaudited project.
 */
export function detectMapKey(raw: unknown): "mcpServers" | "servers" | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of ["mcpServers", "servers"] as const) {
    if (typeof record[key] === "object" && record[key] !== null) return key;
  }
  return undefined;
}

/**
 * `.env`-style file referenced by VS Code's `envFile`. Values there are usually the server's
 * credentials, and connecting without them can yield a different -- smaller -- tool list than
 * the one actually in use.
 */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const body = trimmed.replace(/^export\s+/, "");
    const at = body.indexOf("=");
    if (at <= 0) continue;
    const key = body.slice(0, at).trim();
    let value = body.slice(at + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // A quoted value can run over several lines: a private key, a service account's JSON.
      let rest = value.slice(1);
      const closed = (text: string) => text.endsWith(quote) && !text.endsWith(`\\${quote}`);
      while (!closed(rest) && index + 1 < lines.length) {
        index += 1;
        rest += `\n${lines[index] ?? ""}`;
      }
      value = closed(rest) ? rest.slice(0, -1) : rest;
    }
    /*
     * Only a variable name is a name. The names are what reach the lock (`envKeys`), and a line
     * split on its first `=` inside a multi-line value made a fragment of the value a "name": a
     * service account's private key went into a committed file that way.
     */
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface ParsedConfig {
  servers: ConfiguredServer[];
  /** Entries we understood as configuration but cannot audit, with the reason. */
  skipped: UnsupportedServerError[];
}

export async function parseServerMap(
  raw: unknown,
  mapKey: "mcpServers" | "servers",
  source: Omit<LockedSource, "scope"> & { scope?: LockedSource["scope"] },
  context: ExpandContext,
): Promise<ParsedConfig> {
  const servers: ConfiguredServer[] = [];
  const skipped: UnsupportedServerError[] = [];

  if (typeof raw !== "object" || raw === null) return { servers, skipped };
  const map = (raw as Record<string, unknown>)[mapKey];
  if (typeof map !== "object" || map === null) return { servers, skipped };

  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    /*
     * The lock keys servers by name, and a name of `__proto__` does not survive being a key: the
     * server would run and be missing from the lock, so adding one was a change nothing reported.
     */
    if (name === "__proto__") {
      skipped.push(new UnsupportedServerError(name, "a server cannot be named __proto__; rename it"));
      continue;
    }
    const entry = serverEntrySchema.safeParse(value);
    if (!entry.success) {
      skipped.push(new UnsupportedServerError(name, `entry is not a server definition: ${entry.error.issues[0]?.message ?? "unknown"}`));
      continue;
    }
    try {
      if (entry.data.headersHelper !== undefined) {
        // Running it would mean executing a command from a config file to obtain credentials.
        throw new UnsupportedServerError(name, "`headersHelper` runs a command to produce headers, which this tool will not execute");
      }

      const transport = resolveTransport(name, entry.data, context);
      if (transport.type === "stdio" && entry.data.envFile !== undefined) {
        const expanded = expand(entry.data.envFile, context);
        if (expanded.refused.length > 0) throw refusedCredentials(name, expanded.refused);
        if (expanded.unresolved.length > 0) {
          throw new UnsupportedServerError(name, `envFile path contains unresolved placeholders: ${expanded.unresolved.join(", ")}`);
        }
        try {
          // Explicit `env` wins: it is the more specific statement of intent.
          transport.env = { ...(await readEnvFile(resolve(context.workspaceFolder, expanded.value))), ...transport.env };
        } catch (error) {
          throw new UnsupportedServerError(name, `envFile ${expanded.value} could not be read: ${(error as Error).message}`);
        }
      }
      servers.push({ name, source: { ...source }, transport });
    } catch (error) {
      if (error instanceof UnsupportedServerError) skipped.push(error);
      else throw error;
    }
  }
  return { servers, skipped };
}

/** `~/.claude.json` keeps project-scoped servers under the absolute project path. */
export async function parseClaudeJson(
  raw: unknown,
  projectRoot: string,
  source: Omit<LockedSource, "scope">,
  context: ExpandContext,
): Promise<ParsedConfig> {
  const user = await parseServerMap(raw, "mcpServers", { ...source, scope: "user" }, context);
  const projects = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["projects"] : undefined;
  const forProject = typeof projects === "object" && projects !== null ? (projects as Record<string, unknown>)[projectRoot] : undefined;
  const local: ParsedConfig = forProject ? await parseServerMap(forProject, "mcpServers", { ...source, scope: "local" }, context) : { servers: [], skipped: [] };

  return { servers: [...user.servers, ...local.servers], skipped: [...user.skipped, ...local.skipped] };
}

export const CLIENT_MAP_KEY: Record<ClientKind, "mcpServers" | "servers"> = {
  "claude-code": "mcpServers",
  "claude-desktop": "mcpServers",
  vscode: "servers",
  cursor: "mcpServers",
  copilot: "mcpServers",
  windsurf: "mcpServers",
  generic: "mcpServers",
  manual: "mcpServers",
};
