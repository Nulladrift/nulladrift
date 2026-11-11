/** The shape of `mcp.lock`. Mirrors schema/mcp.lock.schema.json, which is the published contract. */

/**
 * Bumped to 2 when the root stopped naming a protocol.
 *
 * Version 1 keyed everything under `servers`, which made the format MCP's rather than the
 * product's: an agent's grants, an OpenAPI surface or a token's scopes had nowhere to live
 * without a second root key and a second diff path. Version 2 keys them all under `subjects`,
 * each tagged with what it is.
 *
 * A version 1 file is upgraded on read rather than refused, and the upgrade is lossless:
 * `kind` is not part of any digest (see `reseal.ts`, which covers an explicit field list), so
 * an upgraded lock reseals to exactly the digests it arrived with and nobody sees drift that
 * is really a format change.
 */
export const LOCKFILE_VERSION = 2;

import type { CapabilityKind } from "../risk/capability";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Lockfile {
  lockfileVersion: number;
  generatedBy?: string;
  policy?: LockPolicy;
  /**
   * Everything this project has pinned, keyed by identity. One map rather than a key per kind,
   * so adding a kind is a new member of `LockedSubject` and not a new branch in every consumer.
   */
  subjects: Record<string, LockedSubject>;
  /**
   * Servers the project knowingly leaves unaudited, by how they are reached: a server that only
   * runs on developers' machines, or needs a credential CI does not hold. Written by
   * `init --allow-unreachable` and by accepting the server in `review`.
   *
   * Under `--allow-unreachable`, a configured server that could not be audited passes only if it
   * is listed here with the same transport. Without the list, a pull request that added a server
   * which refused the auditor -- one that exits when the client says it is nulladrift -- passed
   * with it in the configuration and nothing in the report. Outside the digest and the diff: it
   * pins nothing, it only records what was agreed to go unpinned.
   */
  unaudited?: Record<string, LockedUnaudited>;
}

export interface LockedUnaudited {
  /** Absent for a definition this tool cannot read at all (an unsupported transport). */
  transport?: LockedTransport;
}

/**
 * What a pinned thing is.
 *
 * The list is short because only one reader exists. The point of naming it at all is that the
 * diff engine, the policy evaluator and the audit log already do not care which one they are
 * looking at, so the cost of the second is a reader and a vocabulary rather than a redesign.
 */
export const SUBJECT_KINDS = ["mcp-server"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export interface LockPolicy {
  /** Reverse-DNS `_meta` key prefixes to leave out, for servers that put build ids there. */
  ignoreMetaPrefixes?: string[];
  allowUnreachable?: boolean;
  /**
   * A server whose listing could not be read in full is a warning rather than a failure. The
   * same choice `allowUnreachable` makes about a server that could not be read at all.
   */
  allowPartial?: boolean;
  /**
   * Capabilities no server in this project may have. Checked against the surface itself rather
   * than against the diff, so accepting drift cannot make one allowed and a repository that never
   * changes is still covered.
   *
   * There is deliberately no steering equivalent: a capability is a fact about schema shape, and
   * a steering signal is a regular expression over prose that legitimate servers trip.
   */
  deniedCapabilities?: CapabilityKind[];
}

export type ClientKind =
  | "claude-code"
  | "claude-desktop"
  | "vscode"
  | "cursor"
  | "copilot"
  | "windsurf"
  | "generic"
  | "manual";

export interface LockedSource {
  client: ClientKind;
  /** Repo-relative where possible, else with the home directory written as `~`. Never an absolute machine path. */
  file: string;
  scope?: "project" | "user" | "local";
}

export interface LockedStdioTransport {
  type: "stdio";
  command: string;
  args?: string[];
  /** Names only. The lock is committed; the values are credentials. */
  envKeys?: string[];
  cwd?: string;
}

export interface LockedHttpTransport {
  type: "http" | "sse";
  /** Query string removed: query strings routinely carry tokens. */
  url: string;
  headerKeys?: string[];
}

export type LockedTransport = LockedStdioTransport | LockedHttpTransport;

export interface LockedProtocol {
  era: "modern" | "legacy";
  version: string;
  supportedVersions?: string[];
}

/**
 * What a stdio invocation actually ran: the artifact behind the command, by content address.
 *
 * Everything else in a locked server describes what the server *says* -- its tools, its
 * instructions, even `serverInfo.version`, which is self-reported over the wire. None of it says
 * what code is answering. A release that keeps every tool name, description and schema byte for
 * byte while changing what the tools do is invisible to all of it, and that is the supply-chain
 * attack this category exists to catch.
 *
 * Deliberately outside the server digest. A lock written before this existed, or a run that
 * could not reach a registry, has no provenance; folding it into the digest would turn every
 * upgrade of this tool and every offline run into drift against servers nobody touched. It is
 * compared on its own instead -- before the digest short-circuit, since the case it exists for
 * is the one where the digest has not moved.
 */
export interface LockedProvenance {
  ecosystem: "npm" | "pypi" | "oci" | "file";
  /** The package, image or path, as its registry names it. */
  name: string;
  /** The exact version that ran: never a range, a dist-tag or `latest`. Absent for a file. */
  version?: string;
  /**
   * A content address for exactly those bytes: npm's `dist.integrity`, a PyPI distribution's
   * sha256, an OCI manifest digest, or the sha256 of the file. Absent when it could not be
   * established, which is a gap in the record rather than a claim about the artifact.
   */
  integrity?: string;
  /**
   * How the invocation asked for it -- `@1.2.3`, `^1`, or nothing at all. Kept because it is the
   * actionable half: a server that floats will move on its own, and the fix is in the config.
   */
  requested?: string;
  /**
   * Every file published for this release, by name, with its sha256. PyPI only.
   *
   * `integrity` covers one file -- the sdist, or the first universal wheel -- and that is rarely
   * the one an installer runs: uv and pip take the best wheel for the platform. PyPI also lets a
   * maintainer add a file to a release after it is published. So a platform wheel added to a
   * pinned version, or the pinned file removed so another is chosen, changed what ran and left
   * `integrity` where it was. The release is pinned as the set of its files.
   */
  files?: Record<string, string>;
}

/**
 * A surface that was not read in full: a listing that did not end, or that changed while it was
 * being read. Every reason is a fact the protocol stated, never a guess from a tool's name.
 */
export interface LockedCoverage {
  complete: false;
  reasons: string[];
}

export interface LockedServerInfo {
  name?: string;
  title?: string;
  version?: string;
  description?: string;
  websiteUrl?: string;
  /** Recorded since a security review: a server could point its icon at any URL and compare clean. */
  icons?: LockedIcon[];
}

export interface LockedAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Annotations resolved against the spec's defaults. See docs/lockfile.md §4. */
export interface LockedBehavior {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

export interface LockedIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export interface LockedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: LockedAnnotations;
  behavior: LockedBehavior;
  /** `propertyPath -> HeaderName`, sorted. Derived from `x-mcp-header`. */
  headerParams?: string[];
  icons?: LockedIcon[];
  /**
   * How the tool may be run (`taskSupport`: forbidden, optional, required). A tool that started
   * requiring to be run as a task behaves differently for every client, and was not recorded.
   */
  execution?: JsonObject;
  meta?: JsonObject;
  digest: string;
}

export interface LockedResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: JsonObject;
  icons?: LockedIcon[];
  meta?: JsonObject;
  digest: string;
}

export interface LockedResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: JsonObject;
  icons?: LockedIcon[];
  meta?: JsonObject;
  digest: string;
}

export interface LockedPromptArgument {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

export interface LockedPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: LockedPromptArgument[];
  icons?: LockedIcon[];
  meta?: JsonObject;
  digest: string;
}

/** What every pinned thing carries, whatever it is. */
export interface LockedSubjectBase {
  kind: SubjectKind;
  source: LockedSource;
  digest: string;
}

/** An MCP server's declared capability surface. The first subject kind, and so far the only one. */
export interface LockedMcpServer extends LockedSubjectBase {
  kind: "mcp-server";
  transport: LockedTransport;
  /** What the command resolved to. Stdio only, and only when it could be established. */
  provenance?: LockedProvenance;
  /**
   * Present only when the listing this entry was built from is known to be incomplete. Outside
   * the digest, like provenance: it says how much of the surface was seen, not what the surface is.
   */
  coverage?: LockedCoverage;
  protocol: LockedProtocol;
  serverInfo?: LockedServerInfo;
  capabilities?: JsonObject;
  instructions?: string;
  tools?: LockedTool[];
  resources?: LockedResource[];
  resourceTemplates?: LockedResourceTemplate[];
  prompts?: LockedPrompt[];
}

/**
 * A union of one, deliberately. An agent's grants or an OpenAPI surface joins here, and every
 * consumer that switches on `kind` gets a compiler error pointing at the branch it is missing.
 */
export type LockedSubject = LockedMcpServer;

/** Anything in the lock that carries its own digest and is matched by a stable key. */
export type LockedMember = LockedTool | LockedResource | LockedResourceTemplate | LockedPrompt;
