/**
 * The container wrapper for registry packages. Everything here is about what it takes away.
 *
 * Two containers since a security review. The package is fetched in one that has the network
 * and runs none of its code (`npm install --ignore-scripts`), into a Docker volume; it is run in
 * another with `--network none` and that volume read-only. A hostile package's own code only ever
 * runs where it can reach nothing. Checked by hand against the real image on 11 November 2026:
 * `@modelcontextprotocol/server-sequential-thinking@2.1.1` fetched in two seconds, answered
 * `tools/list` from the offline container, and a request to the registry from that container
 * failed.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_IMAGE, sandboxedStdio, type SandboxOptions } from "../src/crawl/sandbox";

const PKG = { registryType: "npm", identifier: "example-mcp", version: "1.2.3" };

function phases(pkg = PKG, options: SandboxOptions = {}): { run: string[]; fetch: string[]; volume: string } {
  const result = sandboxedStdio(pkg, options);
  if (!result.ok) throw new Error(result.reason);
  return { run: result.transport.type === "stdio" ? result.transport.args : [], fetch: result.fetch.args, volume: result.fetch.volume };
}

/** The values passed with a flag, in order. */
const valuesOf = (args: string[], flag: string) => args.filter((_, index, all) => all[index - 1] === flag);

describe("sandboxedStdio", () => {
  it("runs the package through docker, never directly", () => {
    const result = sandboxedStdio(PKG);
    expect(result.ok && result.transport.type === "stdio" && result.transport.command).toBe("docker");
  });

  it.each(["run", "fetch"] as const)("drops privileges and the host filesystem in the %s container", (phase) => {
    const args = phases()[phase];
    const joined = args.join(" ");
    for (const flag of ["--read-only", "--user node", "--cap-drop ALL", "--security-opt no-new-privileges", "--rm", "--init"]) {
      expect(joined).toContain(flag);
    }
    // No bind mounts at all: nothing on this machine is reachable from inside. The one mount is a
    // Docker volume, created for this package and removed after it.
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-v");
    for (const mount of valuesOf(args, "--mount")) expect(mount).toMatch(/^type=volume,src=nulladrift-crawl-[0-9a-f-]{36},dst=\/home\/node/);
  });

  it.each(["run", "fetch"] as const)("caps what a runaway package can consume in the %s container", (phase) => {
    const joined = phases()[phase].join(" ");
    expect(joined).toContain("--pids-limit 256");
    expect(joined).toContain("--memory 512m");
    expect(joined).toContain("--cpus 1");
  });

  it("runs the package with no network, from the volume read-only", () => {
    const { run, volume } = phases();
    expect(valuesOf(run, "--network")).toEqual(["none"]);
    expect(valuesOf(run, "--mount")).toEqual([`type=volume,src=${volume},dst=/home/node,readonly`]);
  });

  it("fetches with the network and none of the package's code", () => {
    const { fetch, volume } = phases();
    expect(valuesOf(fetch, "--network")).toEqual([]);
    expect(fetch.slice(fetch.indexOf("npm"))).toEqual(["npm", "install", "--prefix", "/home/node/pkg", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "example-mcp@1.2.3"]);
    expect(valuesOf(fetch, "--mount")).toEqual([`type=volume,src=${volume},dst=/home/node`]);
  });

  it("uses a new volume for every package", () => {
    expect(phases().volume).not.toBe(phases().volume);
  });

  it("forwards nothing from this process's environment", () => {
    const result = sandboxedStdio(PKG);
    expect(result.ok && result.transport.type === "stdio" && result.transport.env).toEqual({});
    // Only what each container itself needs.
    expect(valuesOf(phases().fetch, "--env").sort()).toEqual(["HOME=/home/node", "NO_COLOR=1", "npm_config_cache=/tmp/.npm", "npm_config_update_notifier=false"]);
    expect(valuesOf(phases().run, "--env").sort()).toEqual(["HOME=/tmp", "NO_COLOR=1"]);
  });

  /*
   * Ending an audit closed stdin and killed the docker client, and neither stops a container: a
   * package that ignored both ran on after the crawl had finished.
   */
  it("bounds how long either container can live, inside it, under an init process", () => {
    const { run, fetch } = phases(PKG, { lifetimeSeconds: 30, fetchSeconds: 90 });
    for (const args of [run, fetch]) expect(args[args.indexOf("--entrypoint") + 1]).toBe("timeout");
    expect(run.slice(run.indexOf(DEFAULT_SANDBOX_IMAGE) + 1, run.indexOf(DEFAULT_SANDBOX_IMAGE) + 4)).toEqual(["-s", "KILL", "30"]);
    expect(fetch.slice(fetch.indexOf(DEFAULT_SANDBOX_IMAGE) + 1, fetch.indexOf(DEFAULT_SANDBOX_IMAGE) + 4)).toEqual(["-s", "KILL", "90"]);
  });

  it("passes the package name to the launcher as an argument, never inside the script", () => {
    const { run } = phases({ ...PKG, identifier: "@scope/example-mcp" });
    const script = run[run.indexOf("-c") + 1];
    expect(script).toBe('file=$(node -e "$1" "$0") && exec node "$file"');
    expect(script).not.toContain("example-mcp");
    expect(run[run.indexOf("-c") + 2]).toBe("@scope/example-mcp");
  });

  it("points the names for the Docker host and the metadata service back at the container", () => {
    expect(valuesOf(phases().fetch, "--add-host")).toEqual(["host.docker.internal:127.0.0.1", "gateway.docker.internal:127.0.0.1", "metadata.google.internal:127.0.0.1"]);
  });

  it("pins the version, because `latest` is not a thing you can re-measure", () => {
    expect(phases().fetch).toContain("example-mcp@1.2.3");
  });

  it("refuses a versionless entry rather than measuring whatever `latest` is today", () => {
    // Two runs would execute different code under an identical argv, and the diff would book the
    // maintainer's release as the server changing its own capability surface.
    for (const version of [undefined, ""]) {
      const result = sandboxedStdio({ registryType: "npm", identifier: "example-mcp", version });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/no version/);
    }
  });

  it("uses a stock image unless told otherwise", () => {
    expect(phases().run).toContain(DEFAULT_SANDBOX_IMAGE);
    const custom = phases(PKG, { image: "node:24-alpine" });
    expect(custom.run).toContain("node:24-alpine");
    expect(custom.fetch).toContain("node:24-alpine");
  });

  it("refuses anything that is not a plain npm name", () => {
    // A registry entry is attacker-supplied text; it must not be able to add docker flags or
    // shell metacharacters to the command line.
    for (const identifier of ["--privileged", "a b", "pkg; rm -rf /", "$(whoami)", "../escape", "pkg`id`"]) {
      expect(sandboxedStdio({ registryType: "npm", identifier, version: "1.0.0" }).ok).toBe(false);
    }
    expect(sandboxedStdio({ registryType: "npm", identifier: "@scope/pkg", version: "1.0.0" }).ok).toBe(true);
  });

  it("declines registries it cannot express, with a reason", () => {
    const pypi = sandboxedStdio({ registryType: "pypi", identifier: "x", version: "1" });
    expect(pypi.ok).toBe(false);
    expect(pypi.ok === false && pypi.reason).toContain("pypi");
  });
});
