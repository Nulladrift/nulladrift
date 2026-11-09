/**
 * Whether the launcher fetches a package from somewhere other than where it is checked.
 *
 * Provenance asks the registry what `foo@1.2.3` is and pins that. `npx --registry
 * https://elsewhere foo@1.2.3` runs whatever elsewhere serves under that name, and so does a
 * project `.npmrc` naming another registry, `uvx --index-url`, an index set in the environment,
 * or a copy already sitting in `node_modules`, which `npx` prefers to the registry. Each of those
 * pinned the public registry's hash next to code it does not describe, and reported the artifact
 * as checked. A server whose launcher looks somewhere else is reported as unverified instead:
 * there was something to check, and this run could not check the thing that runs.
 *
 * A registry the person running the audit chose (`npm_config_registry` in their own environment)
 * is the one the resolver asks too, so it agrees with itself and is not flagged. One chosen by
 * the configuration under audit is: that configuration is the thing being reviewed, and a
 * registry it picks can answer the audit's question one way and the launcher's another.
 *
 * Reads what each launcher documents and leaves out what needs running it to know: npm's global
 * config and global installs, `uv tool install`ed tools and Docker registry mirrors.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ConfiguredStdio } from "../config/types";
import type { ArtifactReference } from "./provenance";
import { NPM_PUBLIC, NPM_VALUE_FLAGS, UV_VALUE_FLAGS, commandName, npmEnv as envValue, resolverNpmRegistry } from "./provenance";

const PYPI_PUBLIC = "https://pypi.org/simple";

type Env = Record<string, string | undefined>;

export interface SourceContext {
  projectRoot: string;
  /** The environment this process runs in, which the launcher inherits. */
  env?: Env;
  home?: string;
}

/** `registry.yarnpkg.com` serves npm's packages; trailing slashes and host case are not a different registry. */
function canonicalRegistry(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    const host = parsed.host.toLowerCase() === "registry.yarnpkg.com" ? "registry.npmjs.org" : parsed.host.toLowerCase();
    return `${parsed.protocol}//${host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed;
  }
}

function readSmall(path: string): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1_000_000) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `key = value` lines, as `.npmrc` and `pip.conf` write them; keys lowercased, `${VAR}` expanded. */
function readIni(path: string, env: Env): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (readSmall(path) ?? "").split(/\r?\n/)) {
    const match = /^\s*([^;#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2]!.replace(/^(["'])(.*)\1$/, "$2").replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? "");
    out.set(match[1]!.toLowerCase(), value);
  }
  return out;
}

/**
 * The launcher's own options: everything before the package, which is where a launcher reads its
 * flags. After it they belong to the server, and a server taking `--registry` is not a launcher
 * being told where to look.
 */
function launcherOptions(args: string[], valueFlags: Set<string>, explicitFlags: string[]): Array<[string, string | undefined]> {
  const out: Array<[string, string | undefined]> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--" || !arg.startsWith("-") || arg.length === 1) break;
    const equals = arg.indexOf("=");
    if (arg.startsWith("--") && equals > 0) {
      out.push([arg.slice(0, equals).toLowerCase(), arg.slice(equals + 1)]);
      continue;
    }
    if (valueFlags.has(arg) || explicitFlags.includes(arg)) {
      out.push([arg.toLowerCase(), args[index + 1]]);
      index += 1;
      continue;
    }
    out.push([arg.toLowerCase(), undefined]);
  }
  return out;
}

/** The arguments after the launcher's own subcommand: `pnpm dlx`, `npm exec`, `uv tool run`. */
function afterSubcommand(name: string, args: string[]): string[] {
  if ((name === "pnpm" || name === "yarn") && args[0] === "dlx") return args.slice(1);
  if (name === "npm" && (args[0] === "exec" || args[0] === "x")) return args.slice(1);
  if (name === "uv" && args[0] === "tool" && args[1] === "run") return args.slice(2);
  if (name === "pipx" && args[0] === "run") return args.slice(1);
  return args;
}

/** The directories from `start` up to the filesystem root. */
function ancestors(start: string): string[] {
  const out: string[] = [];
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    out.push(dir);
    if (dirname(dir) === dir) return out;
  }
}

/** npm's project: the nearest directory holding a `package.json` or `node_modules`, else where it started. */
function npmPrefix(start: string): string {
  return ancestors(start).find((dir) => existsSync(join(dir, "package.json")) || existsSync(join(dir, "node_modules"))) ?? resolve(start);
}

function npmElsewhere(transport: ConfiguredStdio, reference: ArtifactReference, context: SourceContext): string | undefined {
  const env = context.env ?? process.env;
  const name = commandName(transport.command);
  const base = transport.cwd ?? context.projectRoot;
  const launcherEnv: Env = { ...env, ...transport.env };
  const options = launcherOptions(afterSubcommand(name, transport.args), NPM_VALUE_FLAGS, ["-p", "--package"]);
  const prefix = npmPrefix(base);

  /*
   * A copy already in the project. `npx foo` runs a `foo` found in any `node_modules/.bin` above
   * it before asking a registry, and `npx foo@1.2.3` runs an installed `foo` that satisfies it.
   * `bunx` does the same. `pnpm dlx` and `yarn dlx` always fetch.
   */
  if (name !== "pnpm" && name !== "yarn" && name !== "pnpx") {
    const bin = reference.name.split("/").pop()!;
    for (const dir of ancestors(base)) {
      if (existsSync(join(dir, "node_modules", ...reference.name.split("/"), "package.json")) || existsSync(join(dir, "node_modules", ".bin", bin))) {
        return "a copy installed in node_modules runs instead of the registry's";
      }
    }
  }

  // npm config, highest precedence first: the command line, the environment, the project, the user.
  const cli = new Map(options.filter(([flag]) => flag.startsWith("--")).map(([flag, value]) => [flag.slice(2), value ?? ""]));
  const userconfig = cli.get("userconfig") ?? envValue(launcherEnv, "npm_config_userconfig");
  const levels: Array<(key: string) => string | undefined> = [
    (key) => cli.get(key),
    (key) => envValue(launcherEnv, `npm_config_${key}`),
    ((rc) => (key: string) => rc.get(key))(readIni(join(prefix, ".npmrc"), launcherEnv)),
    ((rc) => (key: string) => rc.get(key))(readIni(userconfig ? resolve(base, userconfig) : join(context.home ?? homedir(), ".npmrc"), launcherEnv)),
  ];
  const setting = (key: string): string | undefined => {
    for (const level of levels) {
      const value = level(key);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const scope = reference.name.startsWith("@") ? reference.name.slice(0, reference.name.indexOf("/")).toLowerCase() : undefined;
  const registry = (scope ? setting(`${scope}:registry`) : undefined) ?? setting("registry") ?? NPM_PUBLIC;
  if (canonicalRegistry(registry) !== canonicalRegistry(resolverNpmRegistry(env))) return "the launcher is pointed at a different npm registry";

  // Yarn Berry and Bun keep their registry in their own files.
  if (name === "yarn") {
    for (const dir of [prefix, context.home ?? homedir()]) {
      const text = readSmall(join(dir, ".yarnrc.yml")) ?? "";
      const server = /^\s*npmRegistryServer:\s*["']?([^"'\s#]+)/m.exec(text)?.[1];
      if ((server && canonicalRegistry(server) !== canonicalRegistry(resolverNpmRegistry(env))) || /^\s*npmScopes:/m.test(text)) {
        return "the launcher is pointed at a different npm registry";
      }
    }
  }
  if (name === "bunx" || name === "bun") {
    for (const dir of [prefix, context.home ?? homedir()]) {
      if (/^\s*(?:registry\s*=|\[install\.scopes\])/m.test(readSmall(join(dir, "bunfig.toml")) ?? "")) {
        return "the launcher is pointed at a different npm registry";
      }
    }
  }
  return undefined;
}

/** Flags with which uv and pipx take a package from somewhere other than PyPI. */
const PYPI_SOURCE_FLAGS = new Set([
  "--index", "--index-url", "-i", "--extra-index-url", "--default-index", "--find-links", "-f", "--no-index", "--pip-args", "--config-file",
]);
/** The same, as environment variables: uv's, and pip's for pipx. */
const PYPI_SOURCE_ENV = [
  "UV_INDEX", "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_EXTRA_INDEX_URL", "UV_FIND_LINKS", "UV_NO_INDEX", "UV_CONFIG_FILE",
  "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_FIND_LINKS", "PIP_NO_INDEX", "PIP_CONFIG_FILE",
];
const PYPI_INDEX_KEY = /^\s*(?:index-url|extra-index-url|default-index|find-links|no-index|\[\[(?:tool\.uv\.)?index\]\])/m;

function pypiElsewhere(transport: ConfiguredStdio, context: SourceContext): string | undefined {
  const env = context.env ?? process.env;
  const name = commandName(transport.command);
  const base = transport.cwd ?? context.projectRoot;
  const home = context.home ?? homedir();
  const launcherEnv: Env = { ...env, ...transport.env };

  if (launcherOptions(afterSubcommand(name, transport.args), UV_VALUE_FLAGS, ["--from", "--spec"]).some(([flag]) => PYPI_SOURCE_FLAGS.has(flag))) {
    return "the launcher is given another package index";
  }
  for (const variable of PYPI_SOURCE_ENV) {
    const value = launcherEnv[variable];
    if (value && canonicalRegistry(value) !== PYPI_PUBLIC) return "the launcher is given another package index";
  }

  // uv's project and user config, and pip's for pipx.
  const files = [
    ...ancestors(base).flatMap((dir) => [join(dir, "uv.toml"), join(dir, "pyproject.toml")]),
    join(launcherEnv["XDG_CONFIG_HOME"] ?? join(home, ".config"), "uv", "uv.toml"),
    "/etc/uv/uv.toml",
    ...(name === "pipx"
      ? [join(home, ".config", "pip", "pip.conf"), join(home, ".pip", "pip.conf"), join(home, "Library", "Application Support", "pip", "pip.conf"), "/etc/pip.conf"]
      : []),
  ];
  for (const file of files) {
    const text = readSmall(file);
    if (text === undefined) continue;
    if (file.endsWith("pyproject.toml") && !/\[\[?tool\.uv/.test(text)) continue;
    if (PYPI_INDEX_KEY.test(text) && !indexIsPublic(text)) return "a config file gives the launcher another package index";
  }
  return undefined;
}

/** A config that names an index, but only PyPI's own. */
function indexIsPublic(text: string): boolean {
  const urls = [...text.matchAll(/^\s*(?:index-url|extra-index-url|default-index|url)\s*=\s*["']?([^"'\s#]+)/gm)].map((match) => match[1]!);
  return urls.length > 0 && urls.every((url) => canonicalRegistry(url) === PYPI_PUBLIC) && !/^\s*(?:find-links|no-index)/m.test(text);
}

/**
 * Why the launcher may run something other than what the registry would describe, or nothing
 * when it asks the same registry the resolver does. Files and images are not considered here:
 * a file is hashed where it lies, and an image reference names its own registry.
 */
export function fetchedElsewhere(transport: ConfiguredStdio, reference: ArtifactReference, context: SourceContext): string | undefined {
  if (reference.ecosystem === "npm") return npmElsewhere(transport, reference, context);
  if (reference.ecosystem === "pypi") return pypiElsewhere(transport, context);
  return undefined;
}
