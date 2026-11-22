/**
 * A stdio server that will not stop, at the deadline and when the CLI exits.
 *
 * When the per-server deadline passed during connect, nothing stopped the process: the SDK's close
 * waits two seconds for a server to leave on its own before it signals, and `main` exits two
 * seconds after it returns, so a server that ignores the end of its input outlived the CLI and was
 * re-parented to PID 1 -- in CI, on every run. Found in an audit.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredServer } from "../src/config/types";
import { captureSurface } from "../src/mcp/capture";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

/** Records every process started from it, ignores SIGTERM and the end of stdin, and answers what it is told to. */
const STUBBORN = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.PID_FILE, process.pid + "\\n");
process.on("SIGTERM", () => {});
process.stdin.on("end", () => {});
setInterval(() => {}, 1000);
if (process.env.ANSWERS === "discovery") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method !== "server/discover") return;
    const result = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private", _meta: { "io.modelcontextprotocol/serverInfo": { name: "stubborn", version: "1.0.0" } } };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  });
}
process.stdin.resume();
`;

const started: number[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone, which is the point.
    }
  }
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stubborn(answers: "nothing" | "discovery"): Promise<{ root: string; script: string; pidFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "nulladrift-stubborn-"));
  dirs.push(root);
  const script = join(root, "stubborn.mjs");
  await writeFile(script, STUBBORN, "utf8");
  const pidFile = join(root, `pids-${answers}`);
  await writeFile(pidFile, "", "utf8");
  return { root, script, pidFile };
}

async function pids(pidFile: string): Promise<number[]> {
  const found = (await readFile(pidFile, "utf8")).split("\n").filter(Boolean).map(Number);
  started.push(...found);
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * What is still running `afterMs` from now. Waited out rather than polled: the SDK starts a second
 * process once its probe gives up, so a moment with nothing running proves nothing.
 */
async function stillRunning(pidFile: string, afterMs: number): Promise<number[]> {
  await new Promise((resolve) => setTimeout(resolve, afterMs));
  return (await pids(pidFile)).filter(alive);
}

const config = (script: string, env: Record<string, string>): ConfiguredServer => ({
  name: "stubborn",
  source: { client: "claude-code", file: ".mcp.json" },
  transport: { type: "stdio", command: process.execPath, args: [script], env },
});

describe("a stdio server that ignores being closed", () => {
  it("is stopped when the deadline passes while connecting", async () => {
    const { script, pidFile } = await stubborn("nothing");
    await expect(captureSurface(config(script, { PID_FILE: pidFile, ANSWERS: "nothing" }), 1_000)).rejects.toThrow(/did not finish within 1000ms/);
    expect(await stillRunning(pidFile, 2_000)).toEqual([]);
  }, 15_000);

  it("is stopped when the deadline passes while its lists are read, without waiting to be asked twice", async () => {
    const { script, pidFile } = await stubborn("discovery");
    await expect(captureSurface(config(script, { PID_FILE: pidFile, ANSWERS: "discovery" }), 2_500)).rejects.toThrow(/did not finish within 2500ms/);
    // SIGTERM is ignored, so this is the SIGKILL that follows it, a second later.
    expect(await stillRunning(pidFile, 1_600)).toEqual([]);
  }, 15_000);

  it("does not outlive the CLI", async () => {
    const { root, script, pidFile } = await stubborn("nothing");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { stubborn: { command: process.execPath, args: [script], env: { PID_FILE: pidFile, ANSWERS: "nothing" } } } }),
      "utf8",
    );
    const cli = spawn(process.execPath, ["--import", "tsx", join(PACKAGE, "src", "index.ts"), "init", "--allow-unreachable", "--timeout", "1000", "--cwd", root], {
      cwd: PACKAGE,
      env: { ...process.env, HOME: join(root, "no-home"), NO_COLOR: "1" },
      stdio: "ignore",
    });
    await new Promise((resolve) => cli.once("exit", resolve));
    // Checked the moment it has exited: anything still running now has been left behind.
    expect((await pids(pidFile)).filter(alive)).toEqual([]);
  }, 20_000);
});
