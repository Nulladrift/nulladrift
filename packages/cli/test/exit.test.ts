/** Exit codes are the CI contract, so the precedence rule gets its own test. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_CLEAN, EXIT_DRIFT, EXIT_INCOMPLETE, resolveExitCode } from "../src/lib/exit";
import { VERSION } from "../src/lib/version";

describe("resolveExitCode", () => {
  it("is 0 when nothing moved", () => {
    expect(resolveExitCode({ driftCount: 0, incompleteCount: 0 })).toBe(EXIT_CLEAN);
  });

  it("is 1 for drift alone", () => {
    expect(resolveExitCode({ driftCount: 3, incompleteCount: 0 })).toBe(EXIT_DRIFT);
  });

  it("is 2 for an unreachable server alone", () => {
    expect(resolveExitCode({ driftCount: 0, incompleteCount: 1 })).toBe(EXIT_INCOMPLETE);
  });

  it("prefers 2 when both happen, because the audit was incomplete", () => {
    // An audit that could not reach every server cannot claim the drift it found is all of it.
    expect(resolveExitCode({ driftCount: 3, incompleteCount: 1 })).toBe(EXIT_INCOMPLETE);
  });
});

describe("version", () => {
  it("matches package.json, which the bundler publishes", async () => {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
