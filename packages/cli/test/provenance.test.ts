/**
 * What code a stdio server actually runs.
 *
 * Every other comparison in the product looks at what a server says about itself. This is the one
 * that looks at the artifact, so its failure modes are worth stating precisely: a wrong package
 * name is worse than none, because it would be pinned and believed; and a registry being down
 * must never look like a change, nor quietly drop a pin somebody already had.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredStdio } from "../src/config/types";
import { diffLockfiles } from "../src/diff";
import {
  carriedForward,
  imageLocation,
  isExact,
  referenceOf,
  resolveReference,
  splitImage,
  splitNpmSpec,
  splitPypiSpec,
  type ArtifactReference,
} from "../src/lock/provenance";
import type { Lockfile, LockedProvenance } from "../src/lock/types";
import { lockOfTools, makeTool } from "./helpers";

const ROOT = "/work/project";
const run = (command: string, ...args: string[]): ConfiguredStdio => ({ type: "stdio", command, args, env: {} });
const ref = (command: string, ...args: string[]) => referenceOf(run(command, ...args), ROOT);

describe("reading an invocation", () => {
  it("reads the npm launchers MCP configs actually use", () => {
    expect(ref("npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp")).toEqual({ ecosystem: "npm", name: "@modelcontextprotocol/server-filesystem" });
    expect(ref("npx", "--yes", "mcp-server@1.2.3")).toEqual({ ecosystem: "npm", name: "mcp-server", requested: "1.2.3" });
    expect(ref("pnpm", "dlx", "mcp-server@latest")).toEqual({ ecosystem: "npm", name: "mcp-server", requested: "latest" });
    expect(ref("yarn", "dlx", "mcp-server")).toEqual({ ecosystem: "npm", name: "mcp-server" });
    expect(ref("bunx", "mcp-server@^2")).toEqual({ ecosystem: "npm", name: "mcp-server", requested: "^2" });
    expect(ref("npm", "exec", "--", "mcp-server@1.0.0")).toEqual({ ecosystem: "npm", name: "mcp-server", requested: "1.0.0" });
    // Windows writes the launcher with an extension; the name is what matters.
    expect(ref("C:\\\\Program Files\\\\nodejs\\\\npx.cmd", "-y", "mcp-server")).toEqual({ ecosystem: "npm", name: "mcp-server" });
  });

  it("takes the package from -p, not the binary named after it", () => {
    // `npx -p pkg bin` runs `bin` out of `pkg`. Pinning `bin` would pin something that is not a package.
    expect(ref("npx", "-y", "-p", "@scope/tools@2.0.0", "tools-mcp")).toEqual({ ecosystem: "npm", name: "@scope/tools", requested: "2.0.0" });
    expect(ref("npx", "--package=@scope/tools", "tools-mcp")).toEqual({ ecosystem: "npm", name: "@scope/tools" });
  });

  it("refuses an npx shell string, which names no package", () => {
    expect(ref("npx", "-c", "mcp-server --stdio")).toBeUndefined();
  });

  it("reads the Python launchers, normalising names the way PyPI does", () => {
    expect(ref("uvx", "mcp-server-git")).toEqual({ ecosystem: "pypi", name: "mcp-server-git" });
    expect(ref("uvx", "Mcp_Server.Git==1.2.0")).toEqual({ ecosystem: "pypi", name: "mcp-server-git", requested: "1.2.0" });
    expect(ref("uvx", "mcp-server-git@1.2.0")).toEqual({ ecosystem: "pypi", name: "mcp-server-git", requested: "1.2.0" });
    expect(ref("uvx", "--python", "3.12", "mcp-server-fetch")).toEqual({ ecosystem: "pypi", name: "mcp-server-fetch" });
    expect(ref("uvx", "--from", "mcp-tools[cli]>=2", "mcp-tool")).toEqual({ ecosystem: "pypi", name: "mcp-tools", requested: ">=2" });
    expect(ref("uv", "tool", "run", "mcp-server-time")).toEqual({ ecosystem: "pypi", name: "mcp-server-time" });
    expect(ref("pipx", "run", "--spec", "mcp-server-sqlite==0.6.2", "mcp-server-sqlite")).toEqual({
      ecosystem: "pypi",
      name: "mcp-server-sqlite",
      requested: "0.6.2",
    });
  });

  it("finds the image in a docker run, past every flag that takes a value", () => {
    expect(ref("docker", "run", "-i", "--rm", "-e", "GITHUB_TOKEN", "ghcr.io/github/github-mcp-server")).toEqual({
      ecosystem: "oci",
      name: "ghcr.io/github/github-mcp-server",
      requested: "latest",
    });
    expect(ref("docker", "run", "-ite", "TOKEN=x", "--network=host", "mcp/fetch:1.4")).toEqual({ ecosystem: "oci", name: "mcp/fetch", requested: "1.4" });
    expect(ref("podman", "run", "--rm", "-v", "/data:/data", "localhost:5000/team/mcp:dev")).toEqual({
      ecosystem: "oci",
      name: "localhost:5000/team/mcp",
      requested: "dev",
    });
    const digest = `sha256:${"a".repeat(64)}`;
    expect(ref("docker", "run", "-i", `mcp/fetch@${digest}`)).toEqual({ ecosystem: "oci", name: "mcp/fetch", requested: digest, digest });
  });

  it("hashes a script given to an interpreter, or a binary named by path", () => {
    expect(ref("node", "dist/index.js")).toEqual({ ecosystem: "file", name: "dist/index.js", path: "/work/project/dist/index.js" });
    expect(ref("python3", "-u", "./server.py")).toEqual({ ecosystem: "file", name: "server.py", path: "/work/project/server.py" });
    expect(ref("./bin/mcp-server", "--stdio")).toEqual({ ecosystem: "file", name: "bin/mcp-server", path: "/work/project/bin/mcp-server" });
    // Relative to the server's own working directory, as the client resolves it.
    expect(referenceOf({ ...run("node", "index.js"), cwd: "/work/project/servers/a" }, ROOT)).toMatchObject({ name: "servers/a/index.js" });
  });

  it("says nothing about what it cannot read with confidence", () => {
    // A module name says nothing about which package provides it.
    expect(ref("python", "-m", "mcp_server_git")).toBeUndefined();
    // A bare command resolves on PATH, which is different on every machine.
    expect(ref("mcp-server-git", "--stdio")).toBeUndefined();
    expect(ref("node", "-e", "require('x')")).toBeUndefined();
    expect(ref("npx", "-y", "git+https://github.com/x/y.git")).toBeUndefined();
    expect(ref("uvx", "--from", "git+https://github.com/x/y", "y")).toBeUndefined();
    expect(ref("docker", "compose", "run", "mcp")).toBeUndefined();
  });
});

describe("splitting specs", () => {
  it("does not mistake an npm scope for a version", () => {
    expect(splitNpmSpec("@scope/name")).toEqual({ name: "@scope/name" });
    expect(splitNpmSpec("@scope/name@1.0.0")).toEqual({ name: "@scope/name", requested: "1.0.0" });
    expect(splitNpmSpec("name@")).toBeUndefined();
    expect(splitNpmSpec("./local")).toBeUndefined();
  });

  it("keeps a PyPI range's operator, and drops the operator from an exact pin", () => {
    expect(splitPypiSpec("pkg==1.0")).toEqual({ name: "pkg", requested: "1.0" });
    expect(splitPypiSpec("pkg~=1.0")).toEqual({ name: "pkg", requested: "~=1.0" });
    expect(splitPypiSpec("https://example.com/pkg.whl")).toBeUndefined();
  });

  it("finds a tag after the last slash, so a registry port is not read as one", () => {
    expect(splitImage("localhost:5000/x")).toEqual({ name: "localhost:5000/x" });
    expect(splitImage("nginx:1.27")).toEqual({ name: "nginx", tag: "1.27" });
    expect(splitImage("nginx@sha256:short")).toBeUndefined();
  });

  it("expands Docker Hub short names the way docker pull does", () => {
    expect(imageLocation("nginx")).toEqual({ host: "registry-1.docker.io", repository: "library/nginx" });
    expect(imageLocation("mcp/fetch")).toEqual({ host: "registry-1.docker.io", repository: "mcp/fetch" });
    expect(imageLocation("docker.io/mcp/fetch")).toEqual({ host: "registry-1.docker.io", repository: "mcp/fetch" });
    expect(imageLocation("ghcr.io/org/repo")).toEqual({ host: "ghcr.io", repository: "org/repo" });
  });
});

describe("whether a request can only ever mean one set of bytes", () => {
  const reference = (overrides: Partial<ArtifactReference>): ArtifactReference => ({ ecosystem: "npm", name: "x", ...overrides });

  it("is true for an exact version and an image digest, and nothing else", () => {
    expect(isExact(reference({ requested: "1.2.3" }))).toBe(true);
    expect(isExact(reference({ requested: "1.2.3-rc.1" }))).toBe(true);
    expect(isExact(reference({ requested: "^1.2.3" }))).toBe(false);
    expect(isExact(reference({ requested: "latest" }))).toBe(false);
    expect(isExact(reference({}))).toBe(false);
    expect(isExact(reference({ ecosystem: "pypi", requested: "1.0" }))).toBe(true);
    expect(isExact(reference({ ecosystem: "pypi", requested: ">=1.0" }))).toBe(false);
    expect(isExact(reference({ ecosystem: "oci", requested: "1.4" }))).toBe(false);
    expect(isExact(reference({ ecosystem: "oci", digest: `sha256:${"b".repeat(64)}` }))).toBe(true);
    // A file can be rebuilt in place at any moment.
    expect(isExact(reference({ ecosystem: "file", path: "/x" }))).toBe(false);
  });
});

/** A registry that answers from a table, and records what it was asked. */
function registry(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const asked: Array<{ url: string; init?: RequestInit }> = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, init });
    const route = routes[url];
    if (!route) return new Response(null, { status: 404 });
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status ?? 200, headers: route.headers });
  }) as typeof fetch;
  return { fetch: fake, asked };
}

describe("resolving against a registry", () => {
  it("asks npm for the version, and records what that resolved to", async () => {
    const { fetch, asked } = registry({
      "https://registry.npmjs.org/@scope%2Fpkg/latest": { body: { version: "2.3.1", dist: { integrity: "sha512-abc" } } },
    });
    const pinned = await resolveReference({ ecosystem: "npm", name: "@scope/pkg" }, { fetch });

    // `latest` is what npx would have run, and the pin records the version it meant today.
    expect(pinned).toEqual({ ecosystem: "npm", name: "@scope/pkg", version: "2.3.1", integrity: "sha512-abc" });
    expect((asked[0]?.init?.headers as Record<string, string>)["user-agent"]).toMatch(/^nulladrift\//);
  });

  it("gives no answer for an npm range rather than computing one", async () => {
    const { fetch, asked } = registry({});
    expect(await resolveReference({ ecosystem: "npm", name: "pkg", requested: "^1" }, { fetch })).toBeUndefined();
    // Not even asked: a semver implementation here could disagree with npm's.
    expect(asked).toHaveLength(0);
  });

  it("records a PyPI release by its source distribution, which later uploads cannot move", async () => {
    const { fetch } = registry({
      "https://pypi.org/pypi/mcp-server-git/json": {
        body: {
          info: { version: "0.6.2" },
          urls: [
            { filename: "mcp_server_git-0.6.2-py3-none-any.whl", packagetype: "bdist_wheel", digests: { sha256: "1".repeat(64) } },
            { filename: "mcp_server_git-0.6.2.tar.gz", packagetype: "sdist", digests: { sha256: "2".repeat(64) } },
          ],
        },
      },
    });
    expect(await resolveReference({ ecosystem: "pypi", name: "mcp-server-git" }, { fetch })).toEqual({
      ecosystem: "pypi",
      name: "mcp-server-git",
      version: "0.6.2",
      integrity: `sha256:${"2".repeat(64)}`,
    });
  });

  it("follows a registry's token challenge to read an image digest", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    let authorized = false;
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://auth.example.com/token")) {
        expect(new URL(url).searchParams.get("scope")).toBe("repository:org/mcp:pull");
        return new Response(JSON.stringify({ token: "anon" }));
      }
      const headers = init?.headers as Record<string, string>;
      if (headers["authorization"] === "Bearer anon") {
        authorized = true;
        return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
      }
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:org/mcp:pull"' },
      });
    }) as typeof fetch;

    const pinned = await resolveReference({ ecosystem: "oci", name: "registry.example.com/org/mcp", requested: "1.4" }, { fetch: fake });
    expect(authorized).toBe(true);
    expect(pinned).toEqual({ ecosystem: "oci", name: "registry.example.com/org/mcp", integrity: digest, requested: "1.4" });
  });

  it("does not follow a token realm that is not https", async () => {
    const { fetch } = registry({
      "https://registry.example.com/v2/org/mcp/manifests/1.4": { status: 401, headers: { "www-authenticate": 'Bearer realm="http://auth.example.com/token"' } },
    });
    expect(await resolveReference({ ecosystem: "oci", name: "registry.example.com/org/mcp", requested: "1.4" }, { fetch })).toBeUndefined();
  });

  it("swallows a registry being down, because that is not the server's fault", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await resolveReference({ ecosystem: "npm", name: "pkg" }, { fetch: down })).toBeUndefined();
  });

  describe("a file", () => {
    const dirs: string[] = [];
    afterEach(async () => {
      await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it("is pinned by the hash of its contents", async () => {
      const dir = await mkdtemp(join(tmpdir(), "nulladrift-provenance-"));
      dirs.push(dir);
      const path = join(dir, "server.js");
      await writeFile(path, "console.log('hi')\n");

      const first = await resolveReference({ ecosystem: "file", name: "server.js", path });
      await writeFile(path, "console.log('changed')\n");
      const second = await resolveReference({ ecosystem: "file", name: "server.js", path });

      expect(first?.integrity).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(second?.integrity).not.toBe(first?.integrity);
    });
  });
});

describe("keeping a pin this run could not re-establish", () => {
  const pinned: LockedProvenance = { ecosystem: "npm", name: "pkg", version: "1.2.3", integrity: "sha512-x", requested: "1.2.3" };

  it("keeps it when the config asks for exactly that version", () => {
    expect(carriedForward(pinned, { ecosystem: "npm", name: "pkg", requested: "1.2.3" })).toBe(pinned);
  });

  it("drops it when the request floats, rather than claim yesterday's version for today's code", () => {
    const floating: LockedProvenance = { ...pinned, requested: "latest" };
    expect(carriedForward(floating, { ecosystem: "npm", name: "pkg", requested: "latest" })).toBeUndefined();
  });

  it("drops it when the config now asks for something else", () => {
    expect(carriedForward(pinned, { ecosystem: "npm", name: "pkg", requested: "1.2.4" })).toBeUndefined();
    expect(carriedForward(pinned, { ecosystem: "npm", name: "other", requested: "1.2.3" })).toBeUndefined();
  });
});

describe("comparing what ran", () => {
  const TOOL = makeTool({ name: "send", description: "Sends a message." });
  const npm = (overrides: Partial<LockedProvenance> = {}): LockedProvenance => ({
    ecosystem: "npm",
    name: "mcp-server",
    version: "1.2.3",
    integrity: "sha512-original",
    ...overrides,
  });
  function locked(provenance: LockedProvenance | undefined, description = "Sends a message."): Lockfile {
    const lock = lockOfTools([makeTool({ ...TOOL, description })]);
    const entry = lock.subjects["example"]!;
    lock.subjects["example"] = provenance ? { ...entry, provenance } : entry;
    return lock;
  }

  it("calls the same npm version with different bytes a substitution", () => {
    const changes = diffLockfiles(locked(npm()), locked(npm({ integrity: "sha512-tampered" })));
    expect(changes.map((change) => change.kind)).toEqual(["server.artifact.substituted"]);
    // High, so the default policy -- which blocks on high -- stops the build.
    expect(changes[0]?.severity).toBe("high");
  });

  it("reports a new version with an unchanged surface, and says that nothing else covers it", () => {
    // The attack this exists for: the code moved and every declared word stayed where it was.
    const changes = diffLockfiles(locked(npm()), locked(npm({ version: "1.2.4", integrity: "sha512-next" })));
    expect(changes.map((change) => change.kind)).toEqual(["server.artifact.changed"]);
    expect(changes[0]?.severity).toBe("medium");
    expect(changes[0]?.summary).toContain("1.2.3 to 1.2.4");
    expect(changes[0]?.summary).toContain("declared surface did not change");
  });

  it("reports a new version beside the surface changes it came with", () => {
    const changes = diffLockfiles(locked(npm()), locked(npm({ version: "1.3.0", integrity: "sha512-next" }), "Sends a message, and reads your files."));
    expect(changes.map((change) => change.kind).sort()).toEqual(["server.artifact.changed", "tool.description.changed"]);
    expect(changes.find((change) => change.kind === "server.artifact.changed")?.summary).not.toContain("did not change");
  });

  it("says nothing when either side has no record", () => {
    // A lock from before this existed, and a run with the registry down: neither is a change.
    expect(diffLockfiles(locked(undefined), locked(npm()))).toEqual([]);
    expect(diffLockfiles(locked(npm()), locked(undefined))).toEqual([]);
  });

  it("does not call a PyPI release a substitution, since releases can gain files", () => {
    const pypi = (integrity: string): LockedProvenance => ({ ecosystem: "pypi", name: "pkg", version: "1.0", integrity });
    const changes = diffLockfiles(locked(pypi(`sha256:${"1".repeat(64)}`)), locked(pypi(`sha256:${"2".repeat(64)}`)));
    expect(changes.map((change) => change.kind)).toEqual(["server.artifact.changed"]);
  });

  it("treats a moved image tag as ordinary", () => {
    const image = (integrity: string): LockedProvenance => ({ ecosystem: "oci", name: "mcp/fetch", requested: "latest", integrity });
    const changes = diffLockfiles(locked(image(`sha256:${"1".repeat(64)}`)), locked(image(`sha256:${"2".repeat(64)}`)));
    expect(changes.map((change) => change.kind)).toEqual(["server.artifact.changed"]);
    expect(changes[0]?.summary).toContain("mcp/fetch:latest now resolves to a different digest");
  });

  it("leaves a renamed package to the transport change that already reports it", () => {
    expect(diffLockfiles(locked(npm()), locked(npm({ name: "other-server" })))).toEqual([]);
  });
});
