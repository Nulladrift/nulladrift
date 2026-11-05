/** A server as some client's configuration file describes it, before we have talked to it. */
import type { ClientKind, LockedSource } from "../lock/types";

export interface ConfiguredStdio {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
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
