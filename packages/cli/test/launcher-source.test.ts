/**
 * A pin describes the registry's package. When the launcher fetches from somewhere else, the pin
 * describes code that did not run, so the server is reported unverified instead of pinned.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { captureAll } from "../src/audit";
import type { ConfiguredStdio } from "../src/config/types";
import { referenceOf } from "../src/lock/provenance";
import { fetchedElsewhere } from "../src/lock/source";
import type { Lockfile } from "../src/lock/types";

const SERVER = fileURLToPath(new URL("./fixtures/servers/wire-server.mjs", import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-source-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), text, "utf8");
  }
  return root;
}

async function elsewhere(
  root: string,
  command: string,
  args: string[],
  { env = {}, serverEnv = {} }: { env?: Record<string, string>; serverEnv?: Record<string, string> } = {},
): Promise<string | undefined> {
  const transport: ConfiguredStdio = { type: "stdio", command, args, env: serverEnv, cwd: root };
  const reference = referenceOf(transport, root);
  if (!reference) throw new Error(`no reference for ${command} ${args.join(" ")}`);
  return fetchedElsewhere(transport, reference, { projectRoot: root, env, home: join(root, "home") });
}

describe("npm: where the launcher fetches from", () => {
  it("leaves the public registry alone", async () => {
    const root = await project();
    expect(await elsewhere(root, "npx", ["-y", "nd-test-server@1.2.3"])).toBeUndefined();
  });

  it("flags --registry given to the launcher, in both spellings", async () => {
    const root = await project();
    expect(await elsewhere(root, "npx", ["--registry", "https://npm.evil.example", "nd-test-server@1.2.3"])).toBeDefined();
    expect(await elsewhere(root, "npx", ["--registry=https://npm.evil.example", "nd-test-server@1.2.3"])).toBeDefined();
    expect(await elsewhere(root, "npm", ["exec", "--registry", "https://npm.evil.example", "nd-test-server@1.2.3"])).toBeDefined();
  });

  it("does not read the server's own --registry argument as the launcher's", async () => {
    const root = await project();
    expect(await elsewhere(root, "npx", ["nd-test-server@1.2.3", "--registry", "https://npm.example"])).toBeUndefined();
  });

  it("flags a registry set in the server's environment, in any case", async () => {
    const root = await project();
    expect(await elsewhere(root, "npx", ["nd-test-server@1.2.3"], { serverEnv: { NPM_CONFIG_REGISTRY: "https://npm.evil.example" } })).toBeDefined();
  });

  it("accepts the registry the person running the audit chose, which the resolver asks too", async () => {
    const root = await project();
    expect(await elsewhere(root, "npx", ["nd-test-server@1.2.3"], { env: { npm_config_registry: "https://mirror.example/npm/" } })).toBeUndefined();
  });

  it("flags a project .npmrc naming another registry, and not one naming the public one", async () => {
    const other = await project({ ".npmrc": "registry=https://npm.evil.example/\n" });
    expect(await elsewhere(other, "npx", ["nd-test-server@1.2.3"])).toBeDefined();

    const same = await project({ ".npmrc": "; setup-node writes this\nregistry=https://registry.npmjs.org/\n" });
    expect(await elsewhere(same, "npx", ["nd-test-server@1.2.3"])).toBeUndefined();
  });

  it("applies a scoped registry to that scope only", async () => {
    const root = await project({ ".npmrc": "@acme:registry=https://npm.acme.example\n" });
    expect(await elsewhere(root, "npx", ["@acme/mcp@1.0.0"])).toBeDefined();
    expect(await elsewhere(root, "npx", ["nd-test-server@1.0.0"])).toBeUndefined();
  });

  it("flags a registry in the user's .npmrc", async () => {
    const root = await project({ "home/.npmrc": "registry=https://npm.evil.example\n" });
    expect(await elsewhere(root, "npx", ["nd-test-server@1.2.3"])).toBeDefined();
  });

  it("flags a copy installed in node_modules, which npx runs before asking a registry", async () => {
    const root = await project({ "node_modules/nd-test-server/package.json": '{"name":"nd-test-server","version":"1.2.3"}' });
    expect(await elsewhere(root, "npx", ["nd-test-server@1.2.3"])).toBeDefined();
    // pnpm dlx always fetches.
    expect(await elsewhere(root, "pnpm", ["dlx", "nd-test-server@1.2.3"])).toBeUndefined();
  });
});

describe("PyPI: where the launcher fetches from", () => {
  it("leaves PyPI alone", async () => {
    const root = await project();
    expect(await elsewhere(root, "uvx", ["nd-test-server==1.2.3"])).toBeUndefined();
  });

  it("flags an index given on the command line", async () => {
    const root = await project();
    expect(await elsewhere(root, "uvx", ["--index-url", "https://pypi.evil.example/simple", "nd-test-server==1.2.3"])).toBeDefined();
    expect(await elsewhere(root, "uvx", ["-i", "https://pypi.evil.example/simple", "nd-test-server==1.2.3"])).toBeDefined();
    expect(await elsewhere(root, "uvx", ["--extra-index-url=https://pypi.evil.example/simple", "nd-test-server==1.2.3"])).toBeDefined();
    expect(await elsewhere(root, "pipx", ["run", "--pip-args=--index-url=https://pypi.evil.example", "nd-test-server==1.2.3"])).toBeDefined();
  });

  it("flags an index set in the environment, unless it is PyPI's own", async () => {
    const root = await project();
    expect(await elsewhere(root, "uvx", ["nd-test-server==1.2.3"], { serverEnv: { UV_INDEX_URL: "https://pypi.evil.example/simple" } })).toBeDefined();
    expect(await elsewhere(root, "uvx", ["nd-test-server==1.2.3"], { env: { PIP_INDEX_URL: "https://pypi.org/simple/" } })).toBeUndefined();
  });

  it("flags an index in uv.toml or in pyproject's tool.uv", async () => {
    const toml = await project({ "uv.toml": '[[index]]\nurl = "https://pypi.evil.example/simple"\n' });
    expect(await elsewhere(toml, "uvx", ["nd-test-server==1.2.3"])).toBeDefined();

    const pyproject = await project({ "pyproject.toml": '[project]\nname = "x"\n\n[[tool.uv.index]]\nurl = "https://pypi.evil.example/simple"\n' });
    expect(await elsewhere(pyproject, "uvx", ["nd-test-server==1.2.3"])).toBeDefined();

    const unrelated = await project({ "pyproject.toml": '[project]\nname = "x"\n' });
    expect(await elsewhere(unrelated, "uvx", ["nd-test-server==1.2.3"])).toBeUndefined();
  });
});

describe("an audit of a server fetched from elsewhere", () => {
  /** A stand-in `npx` that ignores its arguments and runs the fixture server, so no registry is touched. */
  async function fakeNpx(root: string, args: string[]): Promise<void> {
    const npx = join(root, "bin", "npx");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(npx, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(SERVER).href)});\n`, "utf8");
    await chmod(npx, 0o755);
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { pkg: { command: npx, args } } }), "utf8");
  }

  const previous = {
    lockfileVersion: 1,
    subjects: {
      pkg: { provenance: { ecosystem: "npm", name: "nd-test-server", version: "1.2.3", integrity: "sha512-public", requested: "1.2.3" } },
    },
  } as unknown as Lockfile;

  async function audit(root: string) {
    const home = process.env["HOME"];
    process.env["HOME"] = join(root, "home");
    try {
      return await captureAll({ projectRoot: root, timeoutMs: 20_000, provenance: false, previous });
    } finally {
      process.env["HOME"] = home;
    }
  }

  it("keeps the registry's pin when the launcher asks the registry", async () => {
    const root = await project();
    await fakeNpx(root, ["-y", "nd-test-server@1.2.3"]);
    const { lock, unreachable } = await audit(root);
    expect(unreachable).toEqual([]);
    expect(lock.subjects["pkg"]?.provenance?.integrity).toBe("sha512-public");
  });

  it("drops it, and says so, when the launcher is pointed at another registry", async () => {
    const root = await project();
    await fakeNpx(root, ["-y", "--registry", "https://npm.evil.example", "nd-test-server@1.2.3"]);
    const { lock, unreachable, unverified } = await audit(root);
    expect(unreachable).toEqual([]);
    expect(lock.subjects["pkg"]?.provenance).toBeUndefined();
    expect(unverified).toEqual(["pkg"]);
  });
});
