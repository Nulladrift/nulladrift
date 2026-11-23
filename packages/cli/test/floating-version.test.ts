/**
 * A server configured with no exact version runs whatever its registry published last, so every
 * upstream release arrives as drift that fails the build with nothing in the repository changed.
 * In a test organization that was all five upstream changes caught over ten days, and nothing in
 * the output said the fix was a version in the command.
 *
 * These are the configurations that are told so, the ones that are not, the words they are told
 * in, and that being told changes no exit code.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCheck } from "../src/commands/check";
import { runInit } from "../src/commands/init";
import type { CommonOptions } from "../src/commands/options";
import { runPush } from "../src/commands/push";
import type { ConfiguredStdio } from "../src/config/types";
import { EXIT_CLEAN, EXIT_DRIFT } from "../src/lib/exit";
import { floatingRequest, referenceOf } from "../src/lock/provenance";
import type { LockedProvenance } from "../src/lock/types";
import { floatingLine } from "../src/report/floating";
import { renderHumanReport } from "../src/report/human";
import { renderJsonReport } from "../src/report/json";
import { renderSarifReport } from "../src/report/sarif";
import type { AuditReport } from "../src/report/types";

const ROOT = "/work/project";
const DIGEST = `sha256:${"d".repeat(64)}`;
const run = (command: string, ...args: string[]): ConfiguredStdio => ({ type: "stdio", command, args, env: {} });

/** What this run would say about an invocation, given what the registry answered for it. */
function floating(provenance: LockedProvenance | undefined, command: string, ...args: string[]) {
  const reference = referenceOf(run(command, ...args), ROOT);
  if (!reference) throw new Error(`no reference for ${command} ${args.join(" ")}`);
  return floatingRequest(reference, provenance);
}

const MEMORY = "@modelcontextprotocol/server-memory";

describe("which configurations float", () => {
  it("an npm package named with no version", () => {
    expect(floating(undefined, "npx", "-y", MEMORY)).toEqual({ ecosystem: "npm", name: MEMORY, asked: MEMORY });
  });

  it("an npm package named by a dist-tag such as latest", () => {
    expect(floating(undefined, "npx", "-y", `${MEMORY}@latest`)).toEqual({ ecosystem: "npm", name: MEMORY, asked: `${MEMORY}@latest` });
  });

  it("an npm package named by a range", () => {
    expect(floating(undefined, "npx", "-y", `${MEMORY}@^2.1.0`)).toEqual({ ecosystem: "npm", name: MEMORY, asked: `${MEMORY}@^2.1.0` });
    expect(floating(undefined, "pnpm", "dlx", `${MEMORY}@2.x`)).toMatchObject({ asked: `${MEMORY}@2.x` });
  });

  it("not an npm package named by an exact version", () => {
    expect(floating(undefined, "npx", "-y", "@modelcontextprotocol/server-filesystem@2.4.0", ".")).toBeUndefined();
    expect(floating(undefined, "npx", "-y", "mcp-server@1.2.3-rc.1")).toBeUndefined();
  });

  it("a PyPI package named with no version or by a range, and not one pinned with ==", () => {
    expect(floating(undefined, "uvx", "mcp-server-fetch")).toEqual({ ecosystem: "pypi", name: "mcp-server-fetch", asked: "mcp-server-fetch" });
    expect(floating(undefined, "uvx", "--from", "mcp-tools[cli]>=2", "mcp-tool")).toMatchObject({ asked: "mcp-tools>=2" });
    expect(floating(undefined, "uvx", "mcp-server-fetch@latest")).toMatchObject({ asked: "mcp-server-fetch@latest" });
    expect(floating(undefined, "uvx", "mcp-server-fetch==2026.11.18")).toBeUndefined();
    expect(floating(undefined, "uvx", "mcp-server-fetch@2026.11.18")).toBeUndefined();
  });

  it("an image with no tag, or the latest tag", () => {
    expect(floating(undefined, "docker", "run", "-i", "--rm", "mcp/fetch")).toEqual({ ecosystem: "oci", name: "mcp/fetch", asked: "mcp/fetch:latest" });
    expect(floating(undefined, "docker", "run", "-i", "--rm", "mcp/fetch:latest")).toEqual({ ecosystem: "oci", name: "mcp/fetch", asked: "mcp/fetch:latest" });
  });

  it("not an image with a version tag, which is how images are released, or one named by digest", () => {
    expect(floating(undefined, "docker", "run", "-i", "--rm", "mcp/fetch:1.4")).toBeUndefined();
    expect(floating(undefined, "docker", "run", "-i", "--rm", `mcp/fetch@${DIGEST}`)).toBeUndefined();
    expect(floating(undefined, "docker", "run", "-i", "--rm", `mcp/fetch:latest@${DIGEST}`)).toBeUndefined();
  });

  it("not a local file, which changes when the project changes it", () => {
    expect(floating({ ecosystem: "file", name: "server.mjs", integrity: DIGEST }, "node", "./server.mjs")).toBeUndefined();
  });
});

describe("what it says to write instead", () => {
  it("names the npm version this run found running", () => {
    expect(floating({ ecosystem: "npm", name: MEMORY, version: "2.2.1", integrity: "sha512-x" }, "npx", "-y", MEMORY)?.exact).toBe(`${MEMORY}@2.2.1`);
  });

  it("names the PyPI release with ==, whatever spelling the package was given in", () => {
    const fetch: LockedProvenance = { ecosystem: "pypi", name: "mcp-server-fetch", version: "2026.11.18" };
    expect(floating(fetch, "uvx", "mcp-server-fetch")?.exact).toBe("mcp-server-fetch==2026.11.18");
    expect(floating(fetch, "uvx", "MCP_Server.Fetch")?.exact).toBe("mcp-server-fetch==2026.11.18");
  });

  it("names an image by the digest its tag resolved to", () => {
    expect(floating({ ecosystem: "oci", name: "mcp/fetch", integrity: DIGEST, requested: "latest" }, "docker", "run", "-i", "mcp/fetch")?.exact).toBe(`mcp/fetch@${DIGEST}`);
  });

  it("gives the shape of an exact spec when this run found nothing", () => {
    expect(floatingLine(floating(undefined, "npx", "-y", MEMORY)!)).toContain(`as ${MEMORY}@<version>.`);
    expect(floatingLine(floating(undefined, "uvx", "mcp-server-fetch")!)).toContain("as mcp-server-fetch==<version>.");
    expect(floatingLine(floating(undefined, "docker", "run", "mcp/fetch")!)).toContain("by digest, as mcp/fetch@sha256:<digest>.");
  });

  it("does not take another package's version for this one's", () => {
    expect(floating({ ecosystem: "npm", name: "other", version: "9.9.9" }, "npx", "-y", MEMORY)?.exact).toBeUndefined();
  });

  it("says why: the latest release runs, and a new one fails the build with the config unchanged", () => {
    const line = floatingLine(floating({ ecosystem: "npm", name: MEMORY, version: "2.2.1" }, "npx", "-y", MEMORY)!);
    expect(line).toBe(
      `${MEMORY} runs whatever version was published last, so a new release can show up as drift, and fail the build, with no change to the config. Write it as ${MEMORY}@2.2.1, which is what runs now.`,
    );
  });

  it("escapes what the config and the registry wrote, like any text this tool did not", () => {
    const line = floatingLine(floating({ ecosystem: "npm", name: "pkg", version: "1.0.0\u001b[2J" }, "npx", "pkg@next\u001b[32m")!);
    expect(line).not.toContain("\u001b");
    expect(line).toContain("\\u001b[2J");
  });
});

describe("in each report format", () => {
  const report: AuditReport = {
    changes: [],
    unreachable: [],
    serversChecked: 3,
    lockPath: "mcp.lock",
    floating: [
      { server: "fetch", ecosystem: "pypi", name: "mcp-server-fetch", asked: "mcp-server-fetch", exact: "mcp-server-fetch==2026.11.18" },
      { server: "memory", ecosystem: "npm", name: MEMORY, asked: MEMORY, exact: `${MEMORY}@2.2.1` },
    ],
  };

  it("lists each server once in the human report, and still calls a clean run clean", () => {
    const text = renderHumanReport(report);
    expect(text).toContain("2 server(s) name no exact version:");
    expect(text.split("runs whatever version was published last")).toHaveLength(3);
    expect(text).toContain(`Write it as ${MEMORY}@2.2.1, which is what runs now.`);
    expect(text).toContain("Write it as mcp-server-fetch==2026.11.18, which is what runs now.");
    expect(text).toContain("This did not change the verdict.");
    expect(text).toContain("3 server(s) match mcp.lock");
  });

  it("adds nothing to --json, whose shape is a contract with no place for advice", () => {
    const without = JSON.parse(renderJsonReport({ ...report, floating: undefined }, EXIT_CLEAN)) as Record<string, unknown>;
    const withIt = JSON.parse(renderJsonReport(report, EXIT_CLEAN)) as Record<string, unknown>;
    expect(withIt).toEqual(without);
  });

  it("is a SARIF note under its own rule, which is not a change kind", () => {
    const sarif = JSON.parse(renderSarifReport(report)) as any;
    const rule = sarif.runs[0].tool.driver.rules.find((entry: any) => entry.id === "server.artifact.floating");
    expect(rule?.defaultConfiguration.level).toBe("note");
    expect(sarif.runs[0].results).toEqual([
      expect.objectContaining({ ruleId: "server.artifact.floating", level: "note", partialFingerprints: { "mcpAuditChange/v1": "fetch/floating" } }),
      expect.objectContaining({ ruleId: "server.artifact.floating", level: "note", partialFingerprints: { "mcpAuditChange/v1": "memory/floating" } }),
    ]);
    expect(sarif.runs[0].results[1].message.text).toContain(`memory: ${MEMORY} runs whatever version was published last`);
  });

  it("declares no such rule when every server names its version", () => {
    const sarif = JSON.parse(renderSarifReport({ ...report, floating: [] })) as any;
    expect(sarif.runs[0].tool.driver.rules.map((entry: any) => entry.id)).not.toContain("server.artifact.floating");
  });
});

/*
 * End to end, the way the organization above ran it: `npx`, `uvx` and `docker` stand-ins that
 * ignore their arguments and start the fixture server, and a registry answering from a table, so
 * nothing leaves this machine except the push to a control plane on it.
 */
describe("init, check and push", () => {
  const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
  const TIMEOUT_MS = 20_000;
  const dirs: string[] = [];
  let controlPlane: Server;
  let apiUrl = "";

  beforeAll(async () => {
    controlPlane = createServer((request, response) => {
      request.resume();
      request.on("end", () =>
        response.writeHead(201, { "content-type": "application/json" }).end(
          JSON.stringify({ readingId: "0123456789abcdef", verdict: "clean", exitCode: 0, changes: [], decision: { blocked: false, reasons: [] }, url: `${apiUrl}/r/1` }),
        ),
      );
    });
    await new Promise<void>((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => controlPlane.close(() => resolve())));

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  /** The registries, answering with the given release of server-memory; everything else goes where it was going. */
  function registry(memory: string): typeof fetch {
    const real = globalThis.fetch;
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/@modelcontextprotocol%2Fserver-memory/latest")) return Response.json({ version: memory, dist: { integrity: `sha512-memory-${memory}` } });
      if (url.endsWith("/@modelcontextprotocol%2Fserver-filesystem/2.4.0")) return Response.json({ version: "2.4.0", dist: { integrity: "sha512-filesystem" } });
      if (url.endsWith("/mcp-server-fetch/json")) return Response.json({ info: { version: "2026.11.18" }, urls: [] });
      if (url.includes("/v2/mcp/everything/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } });
      if (url.startsWith(apiUrl)) return real(input, init);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  }

  async function project(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "nulladrift-floating-"));
    dirs.push(root);
    await mkdir(join(root, "bin"));
    const launcher = async (name: string) => {
      const path = join(root, "bin", name);
      await writeFile(path, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(SERVER).href)});\n`, "utf8");
      await chmod(path, 0o755);
      return path;
    };
    const [npx, uvx, docker] = [await launcher("npx"), await launcher("uvx"), await launcher("docker")];
    await writeFile(join(root, "server.mjs"), `await import(${JSON.stringify(pathToFileURL(SERVER).href)});\n`, "utf8");
    const servers = {
      memory: { command: npx, args: ["-y", MEMORY] },
      filesystem: { command: npx, args: ["-y", "@modelcontextprotocol/server-filesystem@2.4.0", "."] },
      fetch: { command: uvx, args: ["mcp-server-fetch"] },
      everything: { command: docker, args: ["run", "-i", "--rm", "mcp/everything"] },
      tagged: { command: docker, args: ["run", "-i", "--rm", "mcp/everything:1.4"] },
      local: { command: process.execPath, args: ["./server.mjs"] },
    };
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
    return root;
  }

  function options(root: string, overrides: Partial<CommonOptions> = {}): CommonOptions {
    return { projectRoot: root, lockPath: join(root, "mcp.lock"), configFiles: [], timeoutMs: TIMEOUT_MS, allowUnreachable: false, format: "human", provenance: true, ...overrides };
  }

  /** Everything written to stdout and stderr while `body` runs, with no home directory to read config from. */
  async function captured<T>(root: string, body: () => Promise<T>): Promise<{ result: T; output: string }> {
    const saved = { HOME: process.env["HOME"], GITHUB_ACTIONS: process.env["GITHUB_ACTIONS"], NULLADRIFT_ID_TOKEN: process.env["NULLADRIFT_ID_TOKEN"] };
    process.env["HOME"] = join(root, "home");
    delete process.env["GITHUB_ACTIONS"];
    delete process.env["NULLADRIFT_ID_TOKEN"];
    const writes = [process.stdout.write.bind(process.stdout), process.stderr.write.bind(process.stderr)] as const;
    let output = "";
    const capture = ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      return { result: await body(), output };
    } finally {
      process.stdout.write = writes[0];
      process.stderr.write = writes[1];
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const said = (output: string) => output.split("runs whatever version was published last").length - 1;

  it(
    "says it once per floating server, and the verdict is what it would have been",
    async () => {
      const root = await project();
      vi.stubGlobal("fetch", registry("2.2.1"));

      const init = await captured(root, () => runInit(options(root)));
      expect(init.result).toBe(EXIT_CLEAN);
      expect(said(init.output)).toBe(3);
      expect(init.output).toContain(`${MEMORY} runs whatever version was published last`);
      expect(init.output).toContain(`Write it as ${MEMORY}@2.2.1, which is what runs now.`);
      expect(init.output).toContain("mcp-server-fetch runs whatever version was published last");
      expect(init.output).toContain(`Write it as mcp/everything@${DIGEST}, which is what runs now.`);
      for (const quiet of ["server-filesystem", "mcp/everything:1.4", "server.mjs"]) expect(init.output).not.toContain(`${quiet} runs whatever`);

      const clean = await captured(root, () => runCheck(options(root)));
      expect(clean.result).toBe(EXIT_CLEAN);
      expect(said(clean.output)).toBe(3);
      expect(clean.output).toContain("3 server(s) name no exact version:");
      expect(clean.output).toContain("6 server(s) match");

      // Upstream publishes. Nothing in the project changed, and the build fails as it always did.
      vi.stubGlobal("fetch", registry("2.2.2"));
      const released = await captured(root, () => runCheck(options(root)));
      expect(released.result).toBe(EXIT_DRIFT);
      expect(released.output).toContain("server.artifact.changed");
      expect(released.output).toContain(`Write it as ${MEMORY}@2.2.2, which is what runs now.`);
      expect(said(released.output)).toBe(3);

      const json = await captured(root, () => runCheck(options(root, { format: "json" })));
      expect(json.result).toBe(EXIT_DRIFT);
      expect(said(json.output)).toBe(0);
      expect(JSON.parse(json.output)).toMatchObject({ exitCode: EXIT_DRIFT });

      // Without the registry there is no release to name, and still a version to write down.
      const offline = await captured(root, () => runCheck(options(root, { provenance: false })));
      expect(offline.result).toBe(EXIT_CLEAN);
      expect(offline.output).toContain(`Write it with an exact version, as ${MEMORY}@<version>.`);

      const push = await captured(root, () => runPush({ ...options(root), apiUrl, token: "ndft_test", project: "web" }));
      expect(push.result).toBe(EXIT_CLEAN);
      expect(said(push.output)).toBe(3);
      expect(push.output).toContain(`memory: ${MEMORY} runs whatever version was published last`);
    },
    TIMEOUT_MS * 6,
  );

  it(
    "says nothing of a bare npx name the project has installed, since that copy is what runs",
    async () => {
      const root = await project();
      await mkdir(join(root, "node_modules", "@modelcontextprotocol", "server-memory"), { recursive: true });
      await writeFile(join(root, "node_modules", "@modelcontextprotocol", "server-memory", "package.json"), "{}", "utf8");
      vi.stubGlobal("fetch", registry("2.2.1"));

      const init = await captured(root, () => runInit(options(root)));
      expect(init.result).toBe(EXIT_CLEAN);
      expect(init.output).not.toContain(`${MEMORY} runs whatever`);
      expect(said(init.output)).toBe(2);
    },
    TIMEOUT_MS * 3,
  );
});
