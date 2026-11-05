/** Flags shared by the commands that talk to servers. */
export interface CommonOptions {
  projectRoot: string;
  lockPath: string;
  configFiles: string[];
  timeoutMs: number;
  allowUnreachable: boolean;
  format: "human" | "json" | "sarif";
  /**
   * Post the findings onto the pull request being reviewed.
   *
   * Separate from `format`, because it is a delivery and not a rendering: a job usually wants
   * the human report in its log and the comment on the pull request, and making them exclusive
   * would mean choosing which of the two readers to serve.
   */
  comment?: boolean;
}
