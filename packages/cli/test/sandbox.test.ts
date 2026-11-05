/** The container wrapper for registry packages. Everything here is about what it takes away. */
import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_IMAGE, sandboxedStdio } from "../src/crawl/sandbox";

function argsFor(pkg = { registryType: "npm", identifier: "example-mcp", version: "1.2.3" }): string[] {
  const result = sandboxedStdio(pkg);
  if (!result.ok) throw new Error(result.reason);
  return result.transport.type === "stdio" ? result.transport.args : [];
}

describe("sandboxedStdio", () => {
  it("runs the package through docker, never directly", () => {
    const result = sandboxedStdio({ registryType: "npm", identifier: "example-mcp", version: "1.2.3" });
    expect(result.ok && result.transport.type === "stdio" && result.transport.command).toBe("docker");
  });

  it("drops privileges, the host filesystem and the host environment", () => {
    const args = argsFor().join(" ");
    for (const flag of ["--read-only", "--user node", "--cap-drop ALL", "--security-opt no-new-privileges", "--rm"]) {
      expect(args).toContain(flag);
    }
    // No bind mounts at all: nothing on this machine is reachable from inside.
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-v ");
  });

  it("caps what a runaway package can consume", () => {
    const args = argsFor().join(" ");
    expect(args).toContain("--pids-limit 256");
    expect(args).toContain("--memory 512m");
    expect(args).toContain("--cpus 1");
  });

  it("forwards nothing from this process's environment", () => {
    const result = sandboxedStdio({ registryType: "npm", identifier: "example-mcp", version: "1.2.3" });
    expect(result.ok && result.transport.type === "stdio" && result.transport.env).toEqual({});
    // Only the four the container itself needs.
    const envFlags = argsFor().filter((_, index, all) => all[index - 1] === "--env");
    expect(envFlags.sort()).toEqual(["HOME=/home/node", "NO_COLOR=1", "npm_config_cache=/tmp/.npm", "npm_config_update_notifier=false"]);
  });

  it("pins the version, because `latest` is not a thing you can re-measure", () => {
    expect(argsFor()).toContain("example-mcp@1.2.3");
    expect(argsFor({ registryType: "npm", identifier: "example-mcp", version: "" })).toContain("example-mcp");
  });

  it("uses a stock image unless told otherwise", () => {
    expect(argsFor()).toContain(DEFAULT_SANDBOX_IMAGE);
    const custom = sandboxedStdio({ registryType: "npm", identifier: "x", version: "1.0.0" }, { image: "node:24-alpine" });
    expect(custom.ok && custom.transport.type === "stdio" && custom.transport.args).toContain("node:24-alpine");
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
