/**
 * A command that changes only in which release of its own package it asks for.
 *
 * `init` and `check` advise pinning `npx -y some-server` to `some-server@2.2.1`. Following that,
 * and every upgrade of the pin after it, used to be reported as a command pointing somewhere else,
 * at high severity, while the same release behind an unpinned command was a medium change. These
 * pin the narrow case that is now low, and the look-alikes around it that are not.
 */
import { describe, expect, it } from "vitest";
import { diffLockfiles } from "../src/diff";
import { serversThatShippedNothing, type Change } from "../src/diff/types";
import type { LockedProvenance, LockedStdioTransport } from "../src/lock/types";
import { lock, server } from "./builders";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

const npm = (version: string, integrity = `sha512-${version}`, requested?: string): LockedProvenance => ({
  ecosystem: "npm",
  name: "@modelcontextprotocol/server-memory",
  version,
  integrity,
  ...(requested === undefined ? {} : { requested }),
});

const stdio = (command: string, args: string[], extra: Partial<LockedStdioTransport> = {}): LockedStdioTransport => ({ type: "stdio", command, args, ...extra });

function diff(before: { transport: LockedStdioTransport; provenance?: LockedProvenance }, after: { transport: LockedStdioTransport; provenance?: LockedProvenance }): Change[] {
  return diffLockfiles(lock({ memory: server(before) }), lock({ memory: server(after) }));
}

const transportChange = (changes: Change[]) => changes.find((c) => c.kind === "server.transport.changed");

describe("pinning a package to the release that was already running", () => {
  it("is a low change, and the only one, for npm", () => {
    const changes = diff(
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    );
    expect(changes.map((c) => [c.kind, c.severity])).toEqual([["server.transport.changed", "low"]]);
    expect(changes[0]!.summary).toContain("@modelcontextprotocol/server-memory@2.2.1");
    expect(changes[0]!.summary).toContain("already running");
  });

  it("is low from a dist-tag too", () => {
    const changes = diff(
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@latest"]), provenance: npm("2.2.1", undefined, "latest") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    );
    expect(transportChange(changes)?.severity).toBe("low");
  });

  it("is low for PyPI, in either of uv's spellings, whatever the name's case and separators", () => {
    const pypi: LockedProvenance = { ecosystem: "pypi", name: "mcp-server-fetch", version: "2026.11.18", integrity: "sha256:f" };
    for (const pinned of ["mcp_server_fetch==2026.11.18", "mcp_server_fetch@2026.11.18"]) {
      const changes = diff({ transport: stdio("uvx", ["mcp_server_fetch"]), provenance: pypi }, { transport: stdio("uvx", [pinned]), provenance: { ...pypi, requested: "2026.11.18" } });
      expect(changes.map((c) => [c.kind, c.severity])).toEqual([["server.transport.changed", "low"]]);
    }
  });

  it("is low for an image named by its digest", () => {
    const oci = (requested: string): LockedProvenance => ({ ecosystem: "oci", name: "mcp/fetch", integrity: DIGEST, requested });
    const changes = diff(
      { transport: stdio("docker", ["run", "-i", "--rm", "mcp/fetch"]), provenance: oci("latest") },
      { transport: stdio("docker", ["run", "-i", "--rm", `mcp/fetch@${DIGEST}`]), provenance: oci(DIGEST) },
    );
    expect(changes.map((c) => [c.kind, c.severity])).toEqual([["server.transport.changed", "low"]]);
  });
});

describe("upgrading a pinned package", () => {
  it("leaves the release to provenance and reports the command at low severity", () => {
    const changes = diff(
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.0"]), provenance: npm("2.2.0", undefined, "2.2.0") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    );
    expect(changes.map((c) => [c.kind, c.severity]).sort()).toEqual([
      ["server.artifact.changed", "medium"],
      ["server.transport.changed", "low"],
    ]);
    expect(transportChange(changes)!.summary).toContain("reported beside this");
  });

  it("still says the bytes were substituted when the version holds and the contents do not", () => {
    const changes = diff(
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1", "sha512-old") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", "sha512-new", "2.2.1") },
    );
    expect(changes.find((c) => c.kind === "server.artifact.substituted")?.severity).toBe("high");
  });

  it("moves an image from one digest to another at low severity, with the artifact change beside it", () => {
    const oci = (integrity: string): LockedProvenance => ({ ecosystem: "oci", name: "mcp/fetch", integrity, requested: integrity });
    const changes = diff(
      { transport: stdio("docker", ["run", "-i", "--rm", `mcp/fetch@${DIGEST}`]), provenance: oci(DIGEST) },
      { transport: stdio("docker", ["run", "-i", "--rm", `mcp/fetch@${OTHER_DIGEST}`]), provenance: oci(OTHER_DIGEST) },
    );
    expect(transportChange(changes)?.severity).toBe("low");
    expect(changes.some((c) => c.kind === "server.artifact.changed")).toBe(true);
  });
});

describe("whether a pinned server shipped something", () => {
  it("does not say a server changed without a release when only its config named the version", () => {
    const changes = diff(
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    );
    expect(serversThatShippedNothing(changes)).toEqual([]);
  });

  it("counts the package moving to another version as a release, even when the server reports the same one", () => {
    const changes = diff(
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.0"]), provenance: npm("2.2.0", undefined, "2.2.0") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    );
    expect(changes.some((c) => c.kind === "server.identity.changed")).toBe(false);
    expect(serversThatShippedNothing(changes)).toEqual([]);
  });

  it("still names a server whose bytes changed under the same version", () => {
    const changes = diff(
      { transport: stdio("uvx", ["mcp-server-memory==1.0"]), provenance: { ecosystem: "pypi", name: "mcp-server-memory", version: "1.0", integrity: "sha256:a", requested: "1.0" } },
      { transport: stdio("uvx", ["mcp-server-memory==1.0"]), provenance: { ecosystem: "pypi", name: "mcp-server-memory", version: "1.0", integrity: "sha256:b", requested: "1.0" } },
    );
    expect(changes.map((c) => c.kind)).toEqual(["server.artifact.changed"]);
    expect(serversThatShippedNothing(changes)).toEqual(["memory"]);
  });

  it("still names a server reached by a different command whose surface moved", () => {
    const quiet: Change = { kind: "tool.description.changed", severity: "high", server: "memory", member: "read_graph", summary: "description changed" };
    const changes = diff(
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "other-memory@2.2.1"]), provenance: { ...npm("2.2.1", undefined, "2.2.1"), name: "other-memory" } },
    );
    expect(serversThatShippedNothing([...changes, quiet])).toEqual(["memory"]);
  });
});

describe("a command change that is not only a version keeps high severity", () => {
  const cases: Array<[string, { transport: LockedStdioTransport; provenance?: LockedProvenance }, { transport: LockedStdioTransport; provenance?: LockedProvenance }]> = [
    [
      "unpinning",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", undefined, "2.2.1") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
    ],
    [
      "a range rather than a release",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@^2.2.1"]), provenance: npm("2.2.1", undefined, "^2.2.1") },
    ],
    [
      "a different package",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "server-memory@2.2.1"]), provenance: { ...npm("2.2.1", undefined, "2.2.1"), name: "server-memory" } },
    ],
    [
      "provenance that claims the old name for a different spelling",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@npm:evil@1.0.0"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    ],
    [
      "another argument added beside the version",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1", "--root", "/"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    ],
    [
      "a different runner",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("bunx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    ],
    [
      "a new environment variable",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"], { envKeys: ["NODE_OPTIONS"] }), provenance: npm("2.2.1", undefined, "2.2.1") },
    ],
    [
      "no provenance before",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]) },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]), provenance: npm("2.2.1", undefined, "2.2.1") },
    ],
    [
      "no provenance after",
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]), provenance: npm("2.2.1") },
      { transport: stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2.2.1"]) },
    ],
    [
      "different extras for a PyPI package",
      { transport: stdio("uvx", ["mcp-server-fetch[a]"]), provenance: { ecosystem: "pypi", name: "mcp-server-fetch", version: "1.0" } },
      { transport: stdio("uvx", ["mcp-server-fetch[b]==1.0"]), provenance: { ecosystem: "pypi", name: "mcp-server-fetch", version: "1.0", requested: "1.0" } },
    ],
    [
      "a PyPI direct reference to somewhere else",
      { transport: stdio("uvx", ["mcp-server-fetch"]), provenance: { ecosystem: "pypi", name: "mcp-server-fetch", version: "1.0" } },
      { transport: stdio("uvx", ["mcp-server-fetch @ https://example.test/mcp_server_fetch-1.0-py3-none-any.whl"]), provenance: { ecosystem: "pypi", name: "mcp-server-fetch", version: "1.0" } },
    ],
    [
      "an image tag, which can be moved",
      { transport: stdio("docker", ["run", "-i", "--rm", "mcp/fetch"]), provenance: { ecosystem: "oci", name: "mcp/fetch", integrity: DIGEST, requested: "latest" } },
      { transport: stdio("docker", ["run", "-i", "--rm", "mcp/fetch:1.2"]), provenance: { ecosystem: "oci", name: "mcp/fetch", integrity: DIGEST, requested: "1.2" } },
    ],
  ];

  it.each(cases)("%s", (_label, before, after) => {
    const found = transportChange(diff(before, after));
    expect(found?.severity).toBe("high");
    expect(found?.summary).toBe("the server is reached differently than when it was pinned");
  });
});
