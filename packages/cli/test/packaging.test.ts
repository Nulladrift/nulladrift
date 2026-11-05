/**
 * What actually gets published. These failures only surface at `npm publish` time otherwise,
 * which is the worst moment to find them.
 */
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  name: string;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  publishConfig?: { access?: string } | undefined;
};

const exists = async (relative: string): Promise<boolean> =>
  access(fileURLToPath(new URL(relative, import.meta.url)))
    .then(() => true)
    .catch(() => false);

describe("the published package", () => {
  it("publishes under a name this project owns", () => {
    /*
     * `mcp-audit`, the obvious name, is an unrelated package on npm. Telling people to
     * `npx` a name we do not control would run someone else's code, the exact hazard this
     * tool exists to flag. `nulladrift` was checked free on npm before it was adopted.
     */
    expect(manifest.name).toBe("nulladrift");
    // Unscoped, so no publishConfig.access is needed and `npx nulladrift` needs no prefix.
    expect(manifest.name.startsWith("@")).toBe(false);
    expect(manifest.publishConfig).toBeUndefined();
  });

  it("still installs a short command", () => {
    expect(Object.keys(manifest.bin)).toEqual(["nulladrift"]);
  });

  it("ships the files it says it ships", async () => {
    expect(manifest.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
    // Both live at the repo root and are copied in by prepack.
    expect(manifest.scripts["prepack"]).toContain("README.md");
    expect(manifest.scripts["prepack"]).toContain("LICENSE");
    expect(await exists("../../../README.md")).toBe(true);
    expect(await exists("../../../LICENSE")).toBe(true);
  });

  it("declares the MIT licence the README promises", async () => {
    const license = await readFile(fileURLToPath(new URL("../../../LICENSE", import.meta.url)), "utf8");
    expect(license).toContain("MIT License");
    expect(await readFile(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8")).toContain("MIT");
  });
});
