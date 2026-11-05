/** Reading the config formats that actually ship. One fixture per client. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeSearch, discoverServers, portablePath } from "../src/config/discover";
import { detectMapKey, parseClaudeJson, parseServerMap, readEnvFile } from "../src/config/parsers";

import type { ExpandContext } from "../src/config/expand";
import { expand } from "../src/config/expand";
import { lockTransport } from "../src/lock/build";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const PROJECT = join(FIXTURES, "project");

const context = (env: Record<string, string | undefined> = {}): ExpandContext => ({ workspaceFolder: PROJECT, env });

async function fixture(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURES, relative), "utf8")) as unknown;
}

const source = { client: "claude-code" as const, file: ".mcp.json" };

describe("the mcpServers map (Claude Code, Claude Desktop, Cursor, Copilot, Windsurf)", () => {
  it("reads stdio and HTTP entries from .mcp.json", async () => {
    const parsed = await parseServerMap(await fixture("project/.mcp.json"), "mcpServers", source, context({ PAYMENTS_TOKEN: "t" }));
    const names = parsed.servers.map((server) => server.name);

    expect(names).toContain("filesystem");
    expect(parsed.servers.find((s) => s.name === "filesystem")?.transport).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./src"],
    });
    expect(parsed.servers.find((s) => s.name === "payments")?.transport).toMatchObject({ type: "http" });
    expect(parsed.servers.find((s) => s.name === "legacy-feed")?.transport).toMatchObject({ type: "sse" });
  });

  it("infers stdio from a command and HTTP from a url when no type is given", async () => {
    const parsed = await parseServerMap(await fixture("project/.mcp.json"), "mcpServers", source, context({ PAYMENTS_TOKEN: "t" }));
    expect(parsed.servers.find((s) => s.name === "implicit-stdio")?.transport.type).toBe("stdio");
    expect(parsed.servers.find((s) => s.name === "implicit-http")?.transport.type).toBe("http");
  });

  it("skips a WebSocket server with a reason rather than failing to connect to it", async () => {
    const parsed = await parseServerMap(await fixture("project/.mcp.json"), "mcpServers", source, context({ PAYMENTS_TOKEN: "t" }));
    const skipped = parsed.skipped.find((entry) => entry.serverName === "websocket-server");
    expect(skipped?.message).toContain("WebSocket");
  });

  it("skips an entry whose placeholders cannot be resolved, naming them", async () => {
    const parsed = await parseServerMap(await fixture("project/.mcp.json"), "mcpServers", source, context({ PAYMENTS_TOKEN: "t" }));
    const skipped = parsed.skipped.find((entry) => entry.serverName === "needs-a-prompt");
    expect(skipped?.message).toContain("${NULLADRIFT_FIXTURE_UNSET_HOST}");
  });

  it("reads the Claude Desktop, Windsurf and Copilot files", async () => {
    for (const [path, expected] of [
      ["claude-desktop/claude_desktop_config.json", "desktop-memory"],
      ["windsurf/mcp_config.json", "windsurf-search"],
      ["copilot/mcp-config.json", "copilot-github"],
    ] as const) {
      const parsed = await parseServerMap(await fixture(path), "mcpServers", source, context());
      expect(parsed.servers.map((server) => server.name)).toEqual([expected]);
    }
  });
});

describe("the VS Code servers map", () => {
  const parseVscode = async () =>
    parseServerMap(await fixture("project/.vscode/mcp.json"), "servers", { client: "vscode", file: ".vscode/mcp.json" }, context());

  it("reads .vscode/mcp.json and expands ${workspaceFolder}", async () => {
    const parsed = await parseVscode();
    expect(parsed.servers.find((server) => server.name === "local-notes")?.transport).toMatchObject({ type: "stdio", cwd: PROJECT });
  });

  it("drops a null env value, which VS Code uses to mean 'unset'", async () => {
    const parsed = await parseVscode();
    const notes = parsed.servers.find((server) => server.name === "local-notes");
    const env = notes?.transport.type === "stdio" ? notes.transport.env : {};
    expect(Object.keys(env)).not.toContain("OPTIONAL_FLAG");
    expect(env["TIMEOUT_MS"]).toBe("30000");
  });

  it("skips a server whose credential comes from an editor prompt", async () => {
    /*
     * ${input:...} is resolved by the editor, and the resolved value is usually a credential.
     * Connecting without it would not fail cleanly -- the spec lets tools/list vary by
     * authorization, so we would quietly pin a smaller surface than the one in use. Skipping and
     * saying why is the honest outcome; it counts as an incomplete audit, not a clean one.
     */
    const parsed = await parseVscode();
    expect(parsed.skipped.map((entry) => entry.serverName)).toContain("perplexity");
    expect(parsed.servers.map((server) => server.name)).toEqual(["local-notes", "docs"]);
  });
});

describe("~/.claude.json", () => {
  it("separates user scope from this project's local scope, and ignores other projects", async () => {
    const parsed = await parseClaudeJson(await fixture("home/.claude.json"), "/workspace/demo", { client: "claude-code", file: "~/.claude.json" }, context());
    const byName = Object.fromEntries(parsed.servers.map((server) => [server.name, server]));

    expect(Object.keys(byName).sort()).toEqual(["project-local", "user-wide"]);
    expect(byName["user-wide"]?.source.scope).toBe("user");
    expect(byName["project-local"]?.source.scope).toBe("local");
  });
});

describe("what reaches the committed lockfile", () => {
  it("records env variable names but never their values", async () => {
    const parsed = await parseClaudeJson(await fixture("home/.claude.json"), "/workspace/demo", { client: "claude-code", file: "~/.claude.json" }, context());
    const local = parsed.servers.find((server) => server.name === "project-local");
    const locked = lockTransport(local!);

    expect(locked).toMatchObject({ type: "stdio", envKeys: ["LOCAL_TOKEN"] });
    expect(JSON.stringify(locked)).not.toContain("s3cret-value-never-written");
  });

  it("strips the query string from a URL, because query strings carry tokens", async () => {
    const parsed = await parseServerMap(await fixture("project/.mcp.json"), "mcpServers", source, context({ PAYMENTS_TOKEN: "t" }));
    const locked = lockTransport(parsed.servers.find((server) => server.name === "payments")!);

    expect(locked).toMatchObject({ type: "http", url: "https://mcp.example-payments.com/mcp", headerKeys: ["Authorization"] });
    expect(JSON.stringify(locked)).not.toContain("super-secret");
  });

  it("writes a portable path rather than an absolute one", () => {
    expect(portablePath(join(PROJECT, ".mcp.json"), PROJECT)).toBe(".mcp.json");
    expect(portablePath(join(PROJECT, ".vscode", "mcp.json"), PROJECT)).toBe(".vscode/mcp.json");
  });
});

describe("variable expansion", () => {
  it("handles ${VAR} and ${VAR:-default}", () => {
    expect(expand("${A}/x", context({ A: "one" })).value).toBe("one/x");
    expect(expand("${MISSING:-fallback}", context()).value).toBe("fallback");
    expect(expand("${A:-fallback}", context({ A: "set" })).value).toBe("set");
  });

  it("names what it could not resolve instead of leaving a silent placeholder", () => {
    const result = expand("https://${NOPE}/mcp", context());
    expect(result.unresolved).toEqual(["${NOPE}"]);
  });
});

describe("discovery across a project", () => {
  it("finds every project-scoped config file and merges them, first match winning", async () => {
    // HOME is redirected so the developer's real config cannot make this test flap.
    const previousHome = process.env["HOME"];
    process.env["HOME"] = join(FIXTURES, "empty-home");
    try {
      const discovery = await discoverServers(PROJECT);
      const names = discovery.servers.map((server) => server.name);

      expect(names).toContain("filesystem");
      expect(names).toContain("docs");
      expect(names).toContain("cursor-notes");
      expect(discovery.filesRead.some((path) => path.endsWith(".vscode/mcp.json"))).toBe(true);
      expect(discovery.skipped.map((entry) => entry.serverName)).toContain("websocket-server");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
  });
});


describe("telling one config format from another", () => {
  it("recognises both server-map keys", () => {
    expect(detectMapKey({ mcpServers: {} })).toBe("mcpServers");
    expect(detectMapKey({ servers: {} })).toBe("servers");
    expect(detectMapKey({ inputs: [] })).toBeUndefined();
    expect(detectMapKey(null)).toBeUndefined();
  });

  it("reads a VS Code-shaped file passed with --config instead of silently finding nothing", async () => {
    /*
     * This used to assume `mcpServers`, parse to zero servers, and exit 0 -- a clean bill of
     * health for a project nothing had looked at.
     */
    const root = join(FIXTURES, "empty-home");
    const discovery = await discoverServers(root, [join(PROJECT, ".vscode", "mcp.json")]);
    expect(discovery.servers.map((server) => server.name)).toContain("docs");
    expect(discovery.problems).toEqual([]);
  });

  it("reports a JSON file that is not a client config, rather than ignoring it", async () => {
    const discovery = await discoverServers(join(FIXTURES, "empty-home"), [join(FIXTURES, "envfile", "not-a-config.json")]);
    expect(discovery.problems).toHaveLength(1);
    expect(discovery.problems[0]?.reason).toContain("does not look like an MCP client config");
  });

  it("reports a config that will not parse, rather than auditing nothing and passing", async () => {
    // A trailing comma in .mcp.json used to mean "no servers found", exit 0.
    const discovery = await discoverServers(join(FIXTURES, "empty-home"), [join(FIXTURES, "envfile", "broken.json")]);
    expect(discovery.problems).toHaveLength(1);
    expect(discovery.problems[0]?.reason).toContain("not valid JSON");
  });
});

describe("envFile", () => {
  it("parses comments, exports and quoting", async () => {
    const env = await readEnvFile(join(FIXTURES, "envfile", ".env"));
    expect(env).toEqual({ API_TOKEN: "from-env-file", EXPORTED: "yes", QUOTED: "has spaces", SINGLE: "single quoted" });
  });

  it("merges into the server environment, with explicit env winning", async () => {
    const dir = join(FIXTURES, "envfile");
    const parsed = await parseServerMap(await fixture("envfile/config.json"), "servers", { client: "vscode", file: "config.json" }, {
      workspaceFolder: dir,
      env: {},
    });
    const server = parsed.servers.find((entry) => entry.name === "with-env-file");
    const env = server?.transport.type === "stdio" ? server.transport.env : {};

    expect(env["EXPORTED"]).toBe("yes");
    expect(env["API_TOKEN"]).toBe("explicit-wins");
  });

  it("refuses a server whose headers come from running a command", async () => {
    const parsed = await parseServerMap(await fixture("envfile/config.json"), "servers", { client: "vscode", file: "config.json" }, {
      workspaceFolder: join(FIXTURES, "envfile"),
      env: {},
    });
    const skipped = parsed.skipped.find((entry) => entry.serverName === "with-headers-helper");
    expect(skipped?.message).toContain("will not execute");
  });
});

describe("configs outside the project", () => {
  it("finds the user-scoped files each client uses", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-home-"));
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      await mkdir(join(home, ".cursor"), { recursive: true });
      await mkdir(join(home, ".codeium", "windsurf"), { recursive: true });
      await mkdir(join(home, ".copilot"), { recursive: true });
      await writeFile(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "cursor-global": { command: "a" } } }), "utf8");
      await writeFile(join(home, ".codeium", "windsurf", "mcp_config.json"), JSON.stringify({ mcpServers: { "windsurf-global": { command: "b" } } }), "utf8");
      await writeFile(join(home, ".copilot", "mcp-config.json"), JSON.stringify({ mcpServers: { "copilot-global": { command: "c" } } }), "utf8");
      await writeFile(
        join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { "claude-user": { command: "d" } }, projects: { [home]: { mcpServers: { "claude-local": { command: "e" } } } } }),
        "utf8",
      );

      const discovery = await discoverServers(home);
      const names = discovery.servers.map((server) => server.name);
      expect(names).toEqual(expect.arrayContaining(["cursor-global", "windsurf-global", "copilot-global", "claude-user", "claude-local"]));
      // Paths in the lock are portable, never absolute machine paths.
      for (const server of discovery.servers) expect(server.source.file.startsWith("/")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});

/*
 * A relative `cwd` was passed to the spawn verbatim, so Node resolved it against process.cwd().
 * Auditing from the project root hid it; auditing from anywhere else, which is what `--cwd` and
 * most CI layouts do, started the server in the wrong directory and reported whatever it failed
 * to find there. Apache SkyWalking BanyanDB ships `"cwd": "."`, which is how this surfaced.
 */
describe("a relative cwd is anchored to the project, not to the caller", () => {
  it("resolves `.` against the project root", async () => {
    const project = await mkdtemp(join(tmpdir(), "mcp-cwd-"));
    try {
      await writeFile(
        join(project, ".mcp.json"),
        JSON.stringify({ mcpServers: { banyandb: { cwd: ".", command: "node", args: ["./mcp/dist/index.js"] } } }),
        "utf8",
      );
      const found = await discoverServers(project);
      const server = found.servers.find((entry) => entry.name === "banyandb");
      expect(server?.transport).toMatchObject({ type: "stdio", cwd: project });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("resolves a nested relative cwd too", async () => {
    const project = await mkdtemp(join(tmpdir(), "mcp-cwd-"));
    try {
      await writeFile(
        join(project, ".mcp.json"),
        JSON.stringify({ mcpServers: { s: { cwd: "./mcp", command: "node", args: ["index.js"] } } }),
        "utf8",
      );
      const found = await discoverServers(project);
      expect(found.servers[0]?.transport).toMatchObject({ cwd: join(project, "mcp") });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("leaves an absolute cwd alone", async () => {
    const project = await mkdtemp(join(tmpdir(), "mcp-cwd-"));
    try {
      await writeFile(
        join(project, ".mcp.json"),
        JSON.stringify({ mcpServers: { s: { cwd: "/opt/server", command: "node", args: ["index.js"] } } }),
        "utf8",
      );
      const found = await discoverServers(project);
      expect(found.servers[0]?.transport).toMatchObject({ cwd: "/opt/server" });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

/*
 * "Looked in:" listed only the files that existed. A project with no config of its own therefore
 * reported two paths in the user's home directory and nothing else, giving no way to tell the
 * project itself had been searched -- which is where somebody standing in a repository concludes
 * the tool does not look locally and stops.
 */
describe("discovery reports every path it looked at", () => {
  it("lists the project-local candidates even when none exist", async () => {
    const project = await mkdtemp(join(tmpdir(), "mcp-search-"));
    try {
      const found = await discoverServers(project);
      expect(found.searched).toEqual(expect.arrayContaining([join(project, ".mcp.json"), join(project, ".vscode", "mcp.json"), join(project, ".cursor", "mcp.json")]));
      expect(found.filesRead).not.toContain(join(project, ".mcp.json"));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("marks each path read or absent", async () => {
    const project = await mkdtemp(join(tmpdir(), "mcp-search-"));
    try {
      await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
      const found = await discoverServers(project);
      const described = describeSearch(found.searched, found.filesRead);
      expect(described).toContain(`read    ${join(project, ".mcp.json")}`);
      expect(described).toContain(`absent  ${join(project, ".cursor", "mcp.json")}`);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
