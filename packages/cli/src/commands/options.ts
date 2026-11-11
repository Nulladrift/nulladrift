/** Flags shared by the commands that talk to servers. */
export interface CommonOptions {
  projectRoot: string;
  lockPath: string;
  configFiles: string[];
  timeoutMs: number;
  allowUnreachable: boolean;
  /**
   * A server whose listing could not be read in full warns instead of failing. Off by default:
   * a check that passes over a surface it only partly saw is asserting something it does not know.
   */
  allowPartial?: boolean;
  format: "human" | "json" | "sarif";
  /**
   * Whether steering passages appear in SARIF. Off by default and deliberately a flag: a SARIF
   * result becomes a code-scanning alert, and an alert is a gate wherever a team requires zero
   * open alerts. A regular expression over prose should not acquire that by default.
   */
  sarifSteering?: boolean;
  /**
   * Post the findings onto the pull request being reviewed.
   *
   * Separate from `format`, because it is a delivery and not a rendering: a job usually wants
   * the human report in its log and the comment on the pull request, and making them exclusive
   * would mean choosing which of the two readers to serve.
   */
  comment?: boolean;
  /**
   * Whether to establish what each stdio server runs -- a registry lookup, or a file hash.
   *
   * On by default. Off for an air-gapped run, where every lookup would fail slowly and say so;
   * a pin the configuration names exactly is kept either way.
   */
  provenance?: boolean;
  /** Read user-level client configs too (`--user-configs`). Their servers then go into the lock. */
  userConfigs?: boolean;
}
