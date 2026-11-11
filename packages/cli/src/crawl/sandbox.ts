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
 * What it does **not** take away: network egress. `npx` has to reach the registry to fetch the
 * package, so a hostile package can also reach the network -- including the Docker host's
 * gateway and, on a cloud runner, the metadata service at its link-local address, which hands
 * out the runner's credentials. The names Docker and cloud providers give those
 * (`host.docker.internal`, `metadata.google.internal`) are pointed at the container's own
 * loopback; their addresses are not, and cannot be without a network of its own. Closing that
 * needs a two-phase fetch-then-run with an offline second phase, which is worth doing and is not
 * done here. Run the crawl somewhere you would be willing to run untrusted code, without
 * credentials on the metadata service.
 */
import type { ConfiguredTransport } from "../config/types";

export const DEFAULT_SANDBOX_IMAGE = "node:22-alpine";

export interface SandboxOptions {
  image?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** How long the container may live at all, whatever happens to the client that started it. */
  lifetimeSeconds?: number;
}

export interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
}

export type SandboxResult = { ok: true; transport: ConfiguredTransport } | { ok: false; reason: string };

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

  const args = [
    "run",
    "--rm",
    "--interactive",
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
    "--tmpfs",
    "/home/node:rw,exec,nosuid,size=128m",
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
    // An init process as PID 1, and a hard limit on how long the package can run under it.
    "--init",
    "--entrypoint",
    "timeout",
    options.image ?? DEFAULT_SANDBOX_IMAGE,
    "-s",
    "KILL",
    String(options.lifetimeSeconds ?? 120),
    "npx",
    "--yes",
    spec,
  ];

  // No `env` on the transport: nothing from this machine reaches the package.
  return { ok: true, transport: { type: "stdio", command: "docker", args, env: {} } };
}
