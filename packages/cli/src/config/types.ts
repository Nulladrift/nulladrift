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
   */
  asWritten?: { command: string; args: string[] };
}

/** OAuth settings as a client config states them. Secrets arrive expanded from the environment. */
export interface ConfiguredOAuth {
  clientId?: string;
  clientSecret?: string;
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
