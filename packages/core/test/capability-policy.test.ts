/*
 * Two things the classifier was computing and nothing was acting on: the diff did not ask what a
 * tool gained, and no rule could be written about what a tool is.
 *
 * The first produced an approval screen where arbitrary command execution read "accepts input it
 * did not before" -- the same sentence as gaining an optional string. The second meant every gate
 * in the product was a gate on movement, which cannot express "nothing here may execute
 * processes" and is not enforced at all on a repository that never changes.
 */
import { describe, expect, it } from "vitest";
import { diffLockfiles } from "../src/diff";
import { capabilityViolations } from "../src/risk/policy";
import type { Lockfile } from "../src/lock/types";

const tool = (properties: string[], name = "build_report") => ({
  name,
  description: "Build a report.",
  digest: `d:${name}:${properties.join(",")}`,
  inputSchema: { type: "object", properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])) },
});

const lock = (tools: unknown[]): Lockfile =>
  ({ lockfileVersion: 1, subjects: { rep: { kind: "mcp-server", digest: `s:${JSON.stringify(tools).length}`, tools } } }) as unknown as Lockfile;

describe("the diff says what a tool gained, not only that its schema moved", () => {
  const changes = diffLockfiles(lock([tool(["name"])]), lock([tool(["name", "command"])]));

  it("reports the capability by name", () => {
    const gained = changes.find((change) => change.kind === "tool.capability.gained");
    expect(gained?.summary).toContain("process-exec");
    expect(gained?.summary).toContain("arg:command");
  });

  it("takes its severity from the capability, not from the schema change", () => {
    expect(changes.find((change) => change.kind === "tool.capability.gained")?.severity).toBe("high");
  });

  it("names the tool, so the finding points somewhere", () => {
    expect(changes.find((change) => change.kind === "tool.capability.gained")?.member).toBe("build_report");
  });

  it("says nothing when a tool gains a harmless argument", () => {
    const quiet = diffLockfiles(lock([tool(["name"])]), lock([tool(["name", "nickname"])]));
    expect(quiet.filter((change) => change.kind === "tool.capability.gained")).toEqual([]);
  });

  /*
   * A tool that is new is reported once. `tool.added` is already the finding, and it names what
   * the tool can do; a second `tool.capability.gained` beside it makes a reviewer read the
   * arrival of one tool twice.
   */
  it("puts a new tool's capabilities in its arrival, not in a second finding", () => {
    const added = diffLockfiles(lock([tool(["name"])]), lock([tool(["name"]), tool(["command"], "run_it")]));
    expect(added.filter((change) => change.kind === "tool.capability.gained")).toEqual([]);
    expect(added.find((change) => change.kind === "tool.added")?.summary).toContain("can process-exec");
  });

  it("does not report a capability the tool already had", () => {
    const same = diffLockfiles(lock([tool(["command"])]), lock([tool(["command", "extra"])]));
    expect(same.filter((change) => change.kind === "tool.capability.gained")).toEqual([]);
  });
});

describe("capabilityViolations is a rule about the surface, not about the diff", () => {
  const surface = lock([tool(["name", "command"])]);

  it("finds a forbidden capability in a surface that never moved", () => {
    const found = capabilityViolations(surface, ["process-exec"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ server: "rep", tool: "build_report", kind: "process-exec", evidence: "arg:command" });
  });

  it("says nothing when the policy permits it", () => {
    expect(capabilityViolations(surface, ["database"])).toEqual([]);
  });

  it("says nothing when there is no policy at all", () => {
    expect(capabilityViolations(surface, undefined)).toEqual([]);
    expect(capabilityViolations(surface, [])).toEqual([]);
  });

  /*
   * There is deliberately no steering equivalent of this function. A capability is a fact about
   * schema shape; a steering signal is a regular expression over prose that legitimate servers
   * trip, and nothing that can fail a build may rest on one.
   */
  it("reports every tool that carries it, not just the first", () => {
    const many = lock([tool(["command"], "a"), tool(["cmd"], "b"), tool(["name"], "c")]);
    expect(capabilityViolations(many, ["process-exec"]).map((v) => v.tool)).toEqual(["a", "b"]);
  });

  it("survives a lockfile with no subjects", () => {
    expect(capabilityViolations({ lockfileVersion: 1 } as unknown as Lockfile, ["process-exec"])).toEqual([]);
  });
});
