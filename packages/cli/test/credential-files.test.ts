/**
 * Where `login` keeps a token, after a security review found it trusted whatever was already there.
 *
 * `mode` on `mkdir` and `writeFile` only applies to what they create, so a token directory at 0755
 * and a token file at 0644 -- a dotfiles restore, a `cp -r` -- stayed that way, and the next
 * refresh token went into a world-readable file under a message saying "(owner-only)". A symlink
 * at the file's path was followed, so the token was written wherever it pointed.
 */
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeOwnerOnly } from "../src/mcp/oauth";

const posix = process.platform !== "win32";
const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe.runIf(posix)("writing a token", () => {
  it("is owner-only on a fresh install", async () => {
    const root = await mkdtemp(join(tmpdir(), "nulladrift-creds-"));
    const path = join(root, "auth", "token.json");
    await writeOwnerOnly(path, "{}");
    expect(await mode(join(root, "auth"))).toBe(0o700);
    expect(await mode(path)).toBe(0o600);
  });

  it("tightens a directory and a file that were already wider", async () => {
    const root = await mkdtemp(join(tmpdir(), "nulladrift-creds-"));
    const directory = join(root, "auth");
    await mkdir(directory, { mode: 0o755 });
    const path = join(directory, "token.json");
    await writeFile(path, "old", { mode: 0o644 });

    await writeOwnerOnly(path, "new");
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(path)).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe("new");
  });

  it("replaces a symlink at the token's path instead of writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "nulladrift-creds-"));
    const directory = join(root, "auth");
    await mkdir(directory, { mode: 0o700 });
    const elsewhere = join(root, "readable-by-others.json");
    await writeFile(elsewhere, "untouched", { mode: 0o644 });
    const path = join(directory, "token.json");
    await symlink(elsewhere, path);

    await writeOwnerOnly(path, "secret");
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(elsewhere, "utf8")).toBe("untouched");
    expect(await mode(path)).toBe(0o600);
  });

  it("refuses a token directory that is a link to somewhere else", async () => {
    const root = await mkdtemp(join(tmpdir(), "nulladrift-creds-"));
    const real = join(root, "shared");
    await mkdir(real, { mode: 0o777 });
    await symlink(real, join(root, "auth"));

    await expect(writeOwnerOnly(join(root, "auth", "token.json"), "secret")).rejects.toThrow(/not a plain directory/);
  });
});
