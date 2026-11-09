/** A server as some client's configuration file describes it, before we have talked to it. */
import type { ClientKind, LockedSource } from "../lock/types";

export interface ConfiguredStdio {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /**
   * `command` and `args` exactly as the config file writes them, before `${VAR}` expansion.
   *
   * The expanded forms are what gets spawned; these are what gets written down. A config keeps a
   * credential out of the repository by writing `--token=${API_KEY}`, and the lockfile is a file
   * you are told to commit, so storing the expanded value there puts the secret back into git --
   * past the exact protection the placeholder exists to provide.
   *
   * `cwd` for the same reason, and one more: it is expanded (`${userHome}/...`) and then anchored
   * to the project, so the expanded form is an absolute path on this machine. Written down, that
   * put a local username in a committed file and made the lock differ on every machine, which a
   * CI checkout at another path reported as `server.transport.changed`.
   */
  asWritten?: { command: string; args: string[]; cwd?: string };
}

/** OAuth settings as a client config states them. Secrets arrive expanded from the environment. */
export interface ConfiguredOAuth {
  clientId?: string;
  clientSecret?: string;
  /**
   * The authorization server a client secret is for. Required with `clientSecret`: without it the
   * secret goes to whichever authorization server the MCP server names, and a compromised server
   * can name its own.
   */
  issuer?: string;
  scope?: string;
}

export interface ConfiguredHttp {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  oauth?: ConfiguredOAuth;
  /** The URL as the config writes it, before `${VAR}` expansion. See ConfiguredStdio.asWritten. */
  asWritten?: { url: string };
}

export type ConfiguredTransport = ConfiguredStdio | ConfiguredHttp;

export interface ConfiguredServer {
  name: string;
  source: LockedSource;
  transport: ConfiguredTransport;
}

export interface ConfigFile {
  client: ClientKind;
  /** Absolute path, used to read the file. `LockedSource.file` carries the portable form. */
  path: string;
  scope?: "project" | "user" | "local";
}
