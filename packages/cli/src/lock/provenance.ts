/**
 * Working out what code a stdio server actually runs.
 *
 * A locked server records what the server *says*: its tools, its instructions, even the version
 * it reports over the wire, which is self-reported. None of that says which bytes are answering.
 * A release that keeps every tool name, description and schema identical while changing what the
 * tools do sails through every other comparison in this product, and it is the supply-chain
 * attack the category exists to catch. This is the part that looks at the artifact instead.
 *
 * Two halves, kept apart on purpose:
 *
 *   `referenceOf`        reads the invocation. Pure, and conservative: an invocation it cannot
 *                        read with confidence gets no reference at all. A wrong package name is
 *                        worse than none, because it would be pinned, compared and believed.
 *
 *   `resolveProvenance`  asks a registry, or reads a file. Best effort, bounded, and never
 *                        throws: a registry being down must not fail somebody's build, and a
 *                        resolution that did not happen is an absence rather than a claim.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ConfiguredStdio } from "../config/types";
import { portablePath } from "../config/discover";
import { USER_AGENT } from "../lib/version";
import type { LockedProvenance } from "./types";

export interface ArtifactReference {
  ecosystem: LockedProvenance["ecosystem"];
  /** As the registry names it. For a file, the portable path; for an image, as written. */
  name: string;
  /** What the invocation asked for: `1.2.3`, `^1`, `latest`, a tag, a digest, or nothing. */
  requested?: string;
  /** For a file: its absolute location, to read it. */
  path?: string;
  /** For an image named by digest: the digest itself, which needs no lookup. */
  digest?: string;
}

// ------------------------------------------------------------------------------------- reading

/** What `npm`'s own validation accepts, minus the legacy forms nobody publishes any more. */
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
/** `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`. Anything looser is a range, which floats. */
const NPM_EXACT = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
/** A dist-tag: `latest`, `next`, `beta`. The registry resolves these; it does not resolve ranges. */
const NPM_TAG = /^[a-z][\w.-]*$/i;

/** `@scope/name@1.2.3` → name and requested. The scope's own `@` is not a version separator. */
export function splitNpmSpec(spec: string): { name: string; requested?: string } | undefined {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const requested = at > 0 ? spec.slice(at + 1) : undefined;
  if (!NPM_NAME.test(name)) return undefined;
  if (requested !== undefined && requested.length === 0) return undefined;
  return requested === undefined ? { name } : { name, requested };
}

/** PEP 503: case-insensitive, and `-`, `_` and `.` are the same character. */
function normalizePypi(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** `1.2.3`, `2024.1`, `1.0.0rc1`, `1!2.0`. No operator: an operator is a range. */
const PYPI_EXACT = /^\d[\w.!+-]*$/;

/**
 * `name==1.2.3`, `name@1.2.3` (uv's spelling), `name[extra]>=1`, or a bare `name`.
 *
 * A URL, a path or a VCS reference is not a registry package, so it gets nothing rather than a
 * name that happens to parse out of it.
 */
export function splitPypiSpec(spec: string): { name: string; requested?: string } | undefined {
  const text = spec.trim();
  if (/^(git\+|hg\+|svn\+|bzr\+|https?:|file:|\.|\/|~)/.test(text)) return undefined;

  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[[^\]]*\])?\s*(?:(===?|>=|<=|~=|!=|>|<|@)\s*(\S.*))?$/.exec(text);
  if (!match) return undefined;
  const name = normalizePypi(match[1]!);
  const operator = match[2];
  const value = match[3]?.trim();
  if (operator === undefined) return { name };
  if (value === undefined || value.length === 0) return undefined;
  // `==` and uv's `@` name one version; every other operator names a set of them.
  return operator === "==" || operator === "===" || operator === "@" ? { name, requested: value } : { name, requested: `${operator}${value}` };
}

/**
 * `registry/repo:tag@sha256:...`, any part of it optional but the repository.
 *
 * A port in the registry host is a colon before the last slash, which is why the tag is found
 * after the last slash rather than at the first colon.
 */
export function splitImage(reference: string): { name: string; tag?: string; digest?: string } | undefined {
  let rest = reference;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return undefined;
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!/^[\w][\w.-]{0,127}$/.test(tag)) return undefined;
  }
  if (!/^[a-z0-9]+(?:[._:-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/i.test(rest)) return undefined;
  return { name: rest, ...(tag === undefined ? {} : { tag }), ...(digest === undefined ? {} : { digest }) };
}

/*
 * Flags that consume the next argument. Everything else starting with `-` is taken to be a
 * switch. The lists are deliberately the documented ones: guessing in the other direction would
 * swallow the package name as a flag's value and pin whatever came after it.
 */
export const NPM_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--registry", "--cache", "--userconfig", "--prefix", "-w", "--workspace", "--node-options"]);
export const UV_VALUE_FLAGS = new Set([
  "--from", "--with", "--with-editable", "--with-requirements", "--python", "-p", "--index", "--index-url", "-i",
  "--extra-index-url", "--default-index", "--find-links", "-f", "--constraint", "-c", "--override",
  "--build-constraint", "--refresh-package", "--reinstall-package", "--upgrade-package", "-P", "--directory",
  "--project", "--config-file", "--cache-dir", "--color", "--resolution", "--prerelease", "--exclude-newer",
  "--link-mode", "--env-file", "--spec", "--pip-args", "--keyring-provider", "--index-strategy",
]);
const DOCKER_VALUE_FLAGS = new Set([
  "-a", "--attach", "--add-host", "--annotation", "--blkio-weight", "--blkio-weight-device", "--cap-add", "--cap-drop",
  "--cgroup-parent", "--cgroupns", "--cidfile", "-c", "--cpu-shares", "--cpu-period", "--cpu-quota", "--cpu-rt-period",
  "--cpu-rt-runtime", "--cpus", "--cpuset-cpus", "--cpuset-mems", "--device", "--device-cgroup-rule", "--device-read-bps",
  "--device-read-iops", "--device-write-bps", "--device-write-iops", "--dns", "--dns-option", "--dns-search", "--domainname",
  "--entrypoint", "-e", "--env", "--env-file", "--expose", "--gpus", "--group-add", "--health-cmd", "--health-interval",
  "--health-retries", "--health-start-period", "--health-start-interval", "--health-timeout", "-h", "--hostname", "--ip",
  "--ip6", "--ipc", "--isolation", "--kernel-memory", "-l", "--label", "--label-file", "--link", "--link-local-ip",
  "--log-driver", "--log-opt", "--mac-address", "-m", "--memory", "--memory-reservation", "--memory-swap",
  "--memory-swappiness", "--mount", "--name", "--network", "--net", "--network-alias", "--net-alias", "--oom-score-adj",
  "--pid", "--pids-limit", "--platform", "-p", "--publish", "--pull", "--restart", "--runtime", "--security-opt",
  "--shm-size", "--stop-signal", "--stop-timeout", "--storage-opt", "--sysctl", "--tmpfs", "--ulimit", "-u", "--user",
  "--userns", "--uts", "-v", "--volume", "--volume-driver", "--volumes-from", "-w", "--workdir", "--detach-keys",
]);
/** Short docker switches that take a value, for combined forms like `-ite VAR=1`. */
const DOCKER_VALUE_SHORT = new Set(["a", "c", "e", "h", "l", "m", "p", "u", "v", "w"]);

/**
 * The first positional argument, skipping flags and the values that belong to them.
 *
 * `explicit` is a flag whose value *is* the package (`npx -p`, `uvx --from`, `pipx --spec`): when
 * present, the positional is the binary to run from it, and the package is the flag's value.
 */
function firstPositional(args: string[], valueFlags: Set<string>, explicitFlags: string[], shortValues?: Set<string>): { positional?: string; explicit?: string } {
  let explicit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return { positional: args[index + 1], explicit };

    const equals = arg.indexOf("=");
    if (arg.startsWith("--") && equals > 0) {
      if (explicitFlags.includes(arg.slice(0, equals))) explicit = arg.slice(equals + 1);
      continue;
    }
    if (explicitFlags.includes(arg)) {
      explicit = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (valueFlags.has(arg)) index += 1;
      // `-it`, `-ite VAR`: a run of switches whose last letter may take a value.
      else if (shortValues && !arg.startsWith("--") && arg.length > 2 && shortValues.has(arg.at(-1)!)) index += 1;
      continue;
    }
    return { positional: arg, explicit };
  }
  return { explicit };
}

/**
 * The launcher's bare name. On Windows it is `npx.cmd`, and its path uses backslashes -- which
 * `path.basename` only understands on Windows, so a config written there and audited on a Linux
 * runner would otherwise never be recognised as a launcher at all.
 */
export function commandName(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
}

/** `index.js`, `server.py`: a bare file name is a path when an interpreter is given it. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|tsx?|py|pyw)$/i;

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/") || /[\\/]/.test(value);
}

const SCRIPT_RUNNERS = new Set(["node", "nodejs", "deno", "bun", "tsx", "ts-node", "python", "python3"]);

/**
 * Which artifact this invocation runs, if that can be read off it with confidence.
 *
 * Covers the launchers MCP configurations actually use -- `npx` and its cousins, `uvx` and
 * `pipx`, `docker run`, an interpreter given a script, and a binary named by path. A command
 * found on PATH by bare name is left alone: which file that is depends on the machine, and a
 * pin that means something different on every developer's laptop is not a pin.
 */
export function referenceOf(transport: ConfiguredStdio, projectRoot: string): ArtifactReference | undefined {
  const name = commandName(transport.command);
  const args = transport.args;
  const base = transport.cwd ?? projectRoot;

  const npm = (rest: string[]): ArtifactReference | undefined => {
    const { positional, explicit } = firstPositional(rest, NPM_VALUE_FLAGS, ["-p", "--package"]);
    // `npx -c "cmd"` runs a shell string; there is no package to name.
    if (explicit === undefined && rest.some((arg) => arg === "-c" || arg === "--call" || arg.startsWith("--call="))) return undefined;
    const spec = explicit ?? positional;
    const parsed = spec === undefined ? undefined : splitNpmSpec(spec);
    return parsed ? { ecosystem: "npm", ...parsed } : undefined;
  };

  const pypi = (rest: string[]): ArtifactReference | undefined => {
    const { positional, explicit } = firstPositional(rest, UV_VALUE_FLAGS, ["--from", "--spec"]);
    const spec = explicit ?? positional;
    const parsed = spec === undefined ? undefined : splitPypiSpec(spec);
    return parsed ? { ecosystem: "pypi", ...parsed } : undefined;
  };

  if (name === "npx" || name === "bunx" || name === "pnpx") return npm(args);
  if ((name === "pnpm" || name === "yarn") && args[0] === "dlx") return npm(args.slice(1));
  if (name === "npm" && (args[0] === "exec" || args[0] === "x")) return npm(args.slice(1));

  if (name === "uvx") return pypi(args);
  if (name === "uv" && args[0] === "tool" && args[1] === "run") return pypi(args.slice(2));
  if (name === "pipx" && args[0] === "run") return pypi(args.slice(1));

  if ((name === "docker" || name === "podman") && args[0] === "run") {
    const { positional } = firstPositional(args.slice(1), DOCKER_VALUE_FLAGS, [], DOCKER_VALUE_SHORT);
    const image = positional === undefined ? undefined : splitImage(positional);
    if (!image) return undefined;
    return {
      ecosystem: "oci",
      name: image.name,
      // A digest is the most specific thing the invocation can ask for, and the one that does not move.
      ...(image.digest ? { requested: image.digest, digest: image.digest } : { requested: image.tag ?? "latest" }),
    };
  }

  /*
   * An interpreter and a script. Only the entry point is hashed, so a server split across many
   * modules is covered only as far as its first file -- a real limit, and better than nothing
   * for the commonest local case, which is a single built file or a compiled binary.
   */
  if (SCRIPT_RUNNERS.has(name)) {
    // `python -m pkg` names a module, not a file; which package provides it is not on the line.
    if (args.includes("-m")) return undefined;
    const runArgs = (name === "deno" || name === "bun") && args[0] === "run" ? args.slice(1) : args;
    const { positional } = firstPositional(runArgs, new Set(["-r", "--require", "--import", "--loader", "-e", "--eval", "-c"]), []);
    if (positional === undefined || /^[a-z]+:\/\//i.test(positional)) return undefined;
    if (!looksLikePath(positional) && !SCRIPT_FILE.test(positional)) return undefined;
    const path = resolve(base, positional);
    return { ecosystem: "file", name: portablePath(path, projectRoot), path };
  }

  if (looksLikePath(transport.command)) {
    const path = resolve(base, transport.command);
    return { ecosystem: "file", name: portablePath(path, projectRoot), path };
  }
  return undefined;
}

/**
 * Whether what the invocation asked for can only ever mean one set of bytes.
 *
 * True for an exact npm or PyPI version, which their registries refuse to republish, and for an
 * image named by digest. False for a range, a dist-tag, an image tag, and a file, all of which
 * can point somewhere new tomorrow without the configuration changing at all.
 */
export function isExact(reference: ArtifactReference): boolean {
  switch (reference.ecosystem) {
    case "npm":
      return reference.requested !== undefined && NPM_EXACT.test(reference.requested);
    case "pypi":
      return reference.requested !== undefined && PYPI_EXACT.test(reference.requested);
    case "oci":
      return reference.digest !== undefined;
    case "file":
      return false;
  }
}

// ----------------------------------------------------------------------------------- resolving

export const NPM_PUBLIC = "https://registry.npmjs.org";

/** An environment variable as npm reads it: `npm_config_registry` in any case. */
export function npmEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value) return value;
  return undefined;
}

/** The npm registry the resolver asks: the one the person running the audit configured, or the public one. */
export function resolverNpmRegistry(env: Record<string, string | undefined> = process.env): string {
  return (npmEnv(env, "npm_config_registry") ?? NPM_PUBLIC).replace(/\/+$/, "");
}

export interface ResolveOptions {
  timeoutMs?: number;
  /** Swappable for tests, which must not depend on a public registry being up. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function getJson(url: string, options: ResolveOptions): Promise<unknown> {
  const response = await (options.fetch ?? fetch)(url, {
    // Identified, like every other request this tool makes: see USER_AGENT.
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  return response.json();
}

/**
 * The registry's word on one version: its exact number and the integrity of its tarball.
 *
 * The endpoint takes a version or a dist-tag and resolves either; it does not take a range, so a
 * range gets no answer rather than one computed here with a semver implementation that might
 * disagree with npm's.
 */
async function resolveNpm(reference: ArtifactReference, options: ResolveOptions): Promise<LockedProvenance | undefined> {
  const asked = reference.requested ?? "latest";
  if (!NPM_EXACT.test(asked) && !NPM_TAG.test(asked)) return undefined;

  /*
   * The registry the person running the audit configured, which a mirror or an air-gapped site
   * needs. One the configuration under audit picks is not asked: see `fetchedElsewhere`.
   */
  const registry = resolverNpmRegistry();
  const body = (await getJson(`${registry}/${reference.name.replace("/", "%2F")}/${encodeURIComponent(asked)}`, options)) as
    | { version?: unknown; dist?: { integrity?: unknown; shasum?: unknown } }
    | undefined;
  if (typeof body?.version !== "string") return undefined;

  const integrity =
    typeof body.dist?.integrity === "string" ? body.dist.integrity : typeof body.dist?.shasum === "string" ? `sha1:${body.dist.shasum}` : undefined;
  return { ecosystem: "npm", name: reference.name, version: body.version, ...(integrity ? { integrity } : {}), ...requestedOf(reference) };
}

/**
 * The registry's word on one release.
 *
 * A PyPI release is a set of files rather than one, and which of them an installer picks depends
 * on the platform. The one recorded is the source distribution when there is one and otherwise
 * the first universal wheel by name -- a choice that stays put when somebody later uploads a
 * wheel for another platform, which PyPI allows and which would otherwise read as a change.
 */
async function resolvePypi(reference: ArtifactReference, options: ResolveOptions): Promise<LockedProvenance | undefined> {
  if (reference.requested !== undefined && !PYPI_EXACT.test(reference.requested)) return undefined;

  const base = (process.env["NULLADRIFT_PYPI_URL"] ?? "https://pypi.org/pypi").replace(/\/+$/, "");
  const url = reference.requested ? `${base}/${reference.name}/${encodeURIComponent(reference.requested)}/json` : `${base}/${reference.name}/json`;
  const body = (await getJson(url, options)) as
    | { info?: { version?: unknown }; urls?: Array<{ filename?: unknown; packagetype?: unknown; digests?: { sha256?: unknown } }> }
    | undefined;
  if (typeof body?.info?.version !== "string") return undefined;

  const files = (body.urls ?? []).filter((file) => typeof file.filename === "string");
  const chosen =
    files.find((file) => file.packagetype === "sdist") ??
    files.filter((file) => /-none-any\.whl$/.test(file.filename as string)).sort((a, b) => (a.filename as string).localeCompare(b.filename as string))[0];
  const sha = chosen?.digests?.sha256;
  return {
    ecosystem: "pypi",
    name: reference.name,
    version: body.info.version,
    ...(typeof sha === "string" && /^[a-f0-9]{64}$/.test(sha) ? { integrity: `sha256:${sha}` } : {}),
    ...requestedOf(reference),
  };
}

/** Where an image's manifest lives. Docker Hub's short names expand the way `docker pull` does. */
export function imageLocation(name: string): { host: string; repository: string } {
  const parts = name.split("/");
  const first = parts[0]!;
  const hasHost = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  let host = hasHost ? first : "registry-1.docker.io";
  if (host === "docker.io" || host === "index.docker.io") host = "registry-1.docker.io";
  let repository = hasHost ? parts.slice(1).join("/") : name;
  if (host === "registry-1.docker.io" && !repository.includes("/")) repository = `library/${repository}`;
  return { host, repository };
}

function bearerChallenge(header: string | null): { realm: string; service?: string; scope?: string } | undefined {
  if (!header || !/^bearer\s/i.test(header)) return undefined;
  const fields: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) fields[match[1]!.toLowerCase()] = match[2]!;
  if (!fields["realm"]?.startsWith("https://")) return undefined;
  return { realm: fields["realm"], service: fields["service"], scope: fields["scope"] };
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * What a tag points at right now, by digest, the way `docker pull` would find out.
 *
 * Anonymous only. A private image needs credentials this tool does not hold and should not go
 * looking for, so it gets no answer -- and an image named by digest needs no lookup at all.
 */
async function resolveOci(reference: ArtifactReference, options: ResolveOptions): Promise<LockedProvenance | undefined> {
  if (reference.digest) return { ecosystem: "oci", name: reference.name, integrity: reference.digest, ...requestedOf(reference) };

  const doFetch = options.fetch ?? fetch;
  const { host, repository } = imageLocation(reference.name);
  const url = `https://${host}/v2/${repository}/manifests/${encodeURIComponent(reference.requested ?? "latest")}`;
  const ask = (authorization?: string) =>
    doFetch(url, {
      method: "HEAD",
      headers: { accept: MANIFEST_TYPES, "user-agent": USER_AGENT, ...(authorization ? { authorization } : {}) },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

  let response = await ask();
  if (response.status === 401) {
    const challenge = bearerChallenge(response.headers.get("www-authenticate"));
    if (!challenge) return undefined;
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
    tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${repository}:pull`);
    const grant = (await getJson(tokenUrl.toString(), options)) as { token?: unknown; access_token?: unknown } | undefined;
    const token = typeof grant?.token === "string" ? grant.token : typeof grant?.access_token === "string" ? grant.access_token : undefined;
    if (!token) return undefined;
    response = await ask(`Bearer ${token}`);
  }
  if (!response.ok) return undefined;

  const digest = response.headers.get("docker-content-digest");
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) return undefined;
  return { ecosystem: "oci", name: reference.name, integrity: digest, ...requestedOf(reference) };
}

async function resolveFile(reference: ArtifactReference): Promise<LockedProvenance | undefined> {
  if (!reference.path) return undefined;
  const bytes = await readFile(reference.path);
  return { ecosystem: "file", name: reference.name, integrity: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

function requestedOf(reference: ArtifactReference): { requested?: string } {
  return reference.requested === undefined ? {} : { requested: reference.requested };
}

/** The artifact behind a reference, or nothing if it could not be established. Never throws. */
export async function resolveReference(reference: ArtifactReference, options: ResolveOptions = {}): Promise<LockedProvenance | undefined> {
  try {
    switch (reference.ecosystem) {
      case "npm":
        return await resolveNpm(reference, options);
      case "pypi":
        return await resolvePypi(reference, options);
      case "oci":
        return await resolveOci(reference, options);
      case "file":
        return await resolveFile(reference);
    }
  } catch {
    return undefined;
  }
}

/**
 * The pin to keep when this run could not establish one.
 *
 * Only when the invocation asks for exactly what was pinned, and asks for something that can
 * only ever mean one set of bytes. A floating request carried forward would claim yesterday's
 * version for code that may have moved since; an exact one carried forward is true by the
 * registry's own rule. Without this, accepting a review while a registry was unreachable would
 * quietly drop every pin in the file.
 */
export function carriedForward(previous: LockedProvenance | undefined, reference: ArtifactReference): LockedProvenance | undefined {
  if (!previous) return undefined;
  if (previous.ecosystem !== reference.ecosystem || previous.name !== reference.name) return undefined;
  if (previous.requested !== reference.requested || !isExact(reference)) return undefined;
  return previous;
}
