/**
 * Upgrading a version 1 lockfile.
 *
 * The question that decides whether the format change was safe to make silently: does a lock
 * written before `subjects` existed still reseal to the digests it already carried? If `kind`
 * had landed inside the digest, every project in the world would have reported drift on the
 * day they upgraded, and the drift would have been a rename.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reseal } from "@nulladrift/core";
import { diffLockfiles } from "@nulladrift/core";
import { LOCKFILE_VERSION } from "../src/lock/types";
import { readLockfile } from "../src/lock/io";
import type { Lockfile } from "../src/lock/types";
import { configured, lockWith, surface } from "./helpers";

async function writeRaw(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nulladrift-upgrade-"));
  const path = join(dir, "mcp.lock");
  await writeFile(path, JSON.stringify(body, null, 2), "utf8");
  return path;
}

/** A version 2 lock, turned back into the version 1 file it would have been written as. */
function downgrade(lock: Lockfile): Record<string, unknown> {
  const servers = Object.fromEntries(
    Object.entries(lock.subjects).map(([name, entry]) => {
      const { kind: _dropped, ...rest } = entry;
      return [name, rest];
    }),
  );
  return { lockfileVersion: 1, generatedBy: lock.generatedBy, ...(lock.policy ? { policy: lock.policy } : {}), servers };
}

describe("reading a version 1 lockfile", () => {
  it("upgrades it rather than refusing", async () => {
    const built = lockWith({ alpha: { config: configured("alpha"), surface: surface() } });
    const path = await writeRaw(downgrade(built));

    const read = await readLockfile(path);
    expect(read.lockfileVersion).toBe(LOCKFILE_VERSION);
    expect(Object.keys(read.subjects)).toEqual(["alpha"]);
    expect(read.subjects["alpha"]?.kind).toBe("mcp-server");
  });

  it("keeps every digest exactly as it was", async () => {
    // The whole safety argument in one assertion.
    const built = lockWith({ alpha: { config: configured("alpha"), surface: surface() } });
    const path = await writeRaw(downgrade(built));
    const read = await readLockfile(path);

    expect(read.subjects["alpha"]?.digest).toBe(built.subjects["alpha"]?.digest);
    expect(read.subjects["alpha"]?.tools?.map((tool) => tool.digest)).toEqual(built.subjects["alpha"]?.tools?.map((tool) => tool.digest));
  });

  it("reseals to the same digest, so the control plane agrees with the collector", async () => {
    const built = lockWith({ alpha: { config: configured("alpha"), surface: surface() } });
    const path = await writeRaw(downgrade(built));
    const read = await readLockfile(path);

    const resealed = reseal(read.subjects["alpha"]!);
    expect(resealed.digest).toBe(built.subjects["alpha"]?.digest);
  });

  it("reports no drift against the version 2 lock it came from", async () => {
    // The failure this guards against is a build going red on the day somebody upgrades,
    // for a change that is entirely in the shape of the file.
    const built = lockWith({ alpha: { config: configured("alpha"), surface: surface() } });
    const path = await writeRaw(downgrade(built));
    const read = await readLockfile(path);

    expect(diffLockfiles(read, built)).toEqual([]);
    expect(diffLockfiles(built, read)).toEqual([]);
  });

  it("still refuses a version it has never heard of", async () => {
    const path = await writeRaw({ lockfileVersion: 99, subjects: {} });
    await expect(readLockfile(path)).rejects.toThrow(/lockfileVersion 99/);
  });
});
