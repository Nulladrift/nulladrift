/**
 * Running a registry package to read its tool list, without running it on this machine.
 *
 * Most MCP servers are npm packages launched over stdio, so a crawl that skips them measures
 * the hosted half of the ecosystem and calls it the whole. Auditing one means executing a
 * third-party package -- which is the exact hazard this project exists to flag, so it happens
 * in a container or not at all.
 *
 * What the sandbox takes away: the host filesystem (no mounts, read-only root, tmpfs for the
 * paths npm needs), privileges (non-root, every capability dropped, no-new-privileges), the
 * host environment (nothing is forwarded; the container gets four variables it needs), and
 * resources (pid, memory and CPU caps).
 *
 * And time: the package runs under `timeout -s KILL`, inside the container, with an init process
 * as PID 1. Ending the audit closed stdin and killed the `docker` client, and neither stops a
 * container: a package that ignored both kept running, with network and a CPU, after the audit
 * and after the whole crawl. Now the container ends itself, however the client went away.
 *
 * And the network, while the package runs. It is fetched first, in a container of its own that
 * has the network and runs nothing of the package's: `npm install --ignore-scripts` into a Docker
 * volume (a named volume, not a mount of anything on this machine). Then it is started in a
 * second container with `--network none` and the volume read-only. A hostile package's code only
 * ever runs where it can reach nothing -- not the registry, not the Docker host's gateway, not a
 * cloud metadata service. The cost is the packages that need an install script to work, which
 * fail to start here and are counted as unreachable rather than run with the network to make
 * them work. The names for the host and the metadata service also point back at the container,
 * which matters only to the fetch.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ConfiguredTransport } from "../config/types";

export const DEFAULT_SANDBOX_IMAGE = "node:22-alpine";

export interface SandboxOptions {
  image?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** How long the container may live at all, whatever happens to the client that started it. */
  lifetimeSeconds?: number;
  /** How long fetching the package may take, in the container that has the network. */
  fetchSeconds?: number;
}

export interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
}

/**
 * The fetch that has to happen before `transport` can start: a container that installs the
 * package into `volume`, and the volume to remove once the server has been read.
 */
export interface SandboxFetch {
  volume: string;
  args: string[];
}

export type SandboxResult = { ok: true; transport: ConfiguredTransport; fetch: SandboxFetch } | { ok: false; reason: string };

/*
 * Finds the package's bin from its own manifest and prints the path, run inside the offline
 * container. The package name arrives as an argument, never as part of this text, so nothing a
 * registry entry says can reach a shell. `npx` was the obvious launcher and resolved the bin's
 * name, then could not find it on the PATH it built for an install prefix.
 */
const RESOLVE_BIN =
  'const fs=require("fs"),path=require("path");const n=process.argv[1];const d=path.join("/home/node/pkg/node_modules",n);' +
  'const m=JSON.parse(fs.readFileSync(path.join(d,"package.json"),"utf8"));' +
  'const b=typeof m.bin==="string"?m.bin:(m.bin&&(m.bin[n.split("/").pop()]||Object.values(m.bin)[0]));' +
  'if(!b){process.stderr.write("the package declares no bin\\n");process.exit(3)}process.stdout.write(path.join(d,b))';

export function sandboxedStdio(pkg: RegistryPackage, options: SandboxOptions = {}): SandboxResult {
  if (pkg.identifier === undefined || pkg.identifier === "") return { ok: false, reason: "package has no identifier" };
  if (pkg.registryType !== "npm") return { ok: false, reason: `unsupported package registry "${pkg.registryType ?? "unknown"}"` };

  /*
   * A versionless entry is not measurable, so it is refused rather than measured badly.
   *
   * `npx --yes pkg` resolves to whatever `latest` is at the moment of the run. Two passes then
   * execute different code while the lockfile records the identical argv, and the diff attributes
   * the maintainer's release to the server's capability surface -- inflating the one number this
   * crawl exists to produce. Counted as unsupported, it shows up as a coverage gap instead.
   */
  if (pkg.version === undefined || pkg.version === "") {
    return { ok: false, reason: "package has no version; an unpinned `latest` cannot be re-measured" };
  }
  const spec = `${pkg.identifier}@${pkg.version}`;
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.+-]+)?$/i.test(spec)) {
    return { ok: false, reason: `package specifier is not a plain npm name: ${spec}` };
  }

  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const volume = `nulladrift-crawl-${randomUUID()}`;
  // What both containers take away: privileges, the host filesystem, and resources.
  const confined = [
    "run",
    "--rm",
    "--read-only",
    "--user",
    "node",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(options.pidsLimit ?? 256),
    "--memory",
    options.memory ?? "512m",
    "--cpus",
    options.cpus ?? "1",
    // npm needs somewhere to write; nothing here survives the run.
    "--tmpfs",
    "/tmp:rw,exec,nosuid,size=256m",
    // An init process as PID 1, so the hard limit below ends the container, not just its client.
    "--init",
  ];

  // Phase one: the network, and none of the package's code. A volume, never a bind mount.
  const fetchArgs = [
    ...confined,
    "--mount",
    `type=volume,src=${volume},dst=/home/node`,
    "--env",
    "HOME=/home/node",
    "--env",
    "npm_config_cache=/tmp/.npm",
    "--env",
    "npm_config_update_notifier=false",
    "--env",
    "NO_COLOR=1",
    // Names that reach the host or the cloud's metadata service, sent back to the container itself.
    "--add-host",
    "host.docker.internal:127.0.0.1",
    "--add-host",
    "gateway.docker.internal:127.0.0.1",
    "--add-host",
    "metadata.google.internal:127.0.0.1",
    "--entrypoint",
    "timeout",
    image,
    "-s",
    "KILL",
    String(options.fetchSeconds ?? 120),
    "npm",
    "install",
    "--prefix",
    "/home/node/pkg",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    spec,
  ];

  // Phase two: the package's code, and no network at all.
  const runArgs = [
    ...confined,
    "--interactive",
    "--network",
    "none",
    "--mount",
    `type=volume,src=${volume},dst=/home/node,readonly`,
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--entrypoint",
    "timeout",
    image,
    "-s",
    "KILL",
    String(options.lifetimeSeconds ?? 120),
    "sh",
    "-c",
    'file=$(node -e "$1" "$0") && exec node "$file"',
    pkg.identifier,
    RESOLVE_BIN,
  ];

  // No `env` on the transport: nothing from this machine reaches the package.
  return { ok: true, transport: { type: "stdio", command: "docker", args: runArgs, env: {} }, fetch: { volume, args: fetchArgs } };
}

/**
 * Runs the fetch. Resolves with a reason when it did not work, never throws: a package that
 * could not be installed is an unreachable entry, not a crawl that stops.
 */
export async function runFetch(fetch: SandboxFetch, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", fetch.args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `could not start docker to fetch the package: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, reason: `fetching the package failed (exit ${code ?? "killed"}): ${stderr.trim().split("\n").slice(-2).join(" ")}` });
    });
  });
}

/** Removes the fetch's volume. Best effort: a volume left behind holds a package, nothing else. */
export async function discardFetch(fetch: SandboxFetch): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["volume", "rm", "-f", fetch.volume], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}
