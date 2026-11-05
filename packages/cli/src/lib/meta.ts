/**
 * Outward-facing URLs.
 *
 * Both are deliberately unset. A `helpUri` lands in GitHub code scanning as a clickable "learn
 * more" on every finding, and a telemetry endpoint is a host we ask permission to talk to --
 * pointing either at something that does not resolve is worse than omitting it. Set them when
 * the repository is public and the collector exists; the code already handles both states, and
 * tests cover the omission.
 */

/**
 * Public repository, used for SARIF `informationUri` / `helpUri`.
 *
 * Settable without a code change: `NULLADRIFT_DOCS_URL` wins, so the links can be turned on by
 * configuration the moment the repository is public. The built-in default stays unset until
 * then -- a `helpUri` is a clickable "learn more" on every finding in a security dashboard, and
 * a 404 there is worse than no link.
 */
const BUILT_IN_DOCS_URL: string | undefined = undefined;

export function publishedDocsUrl(): string | undefined {
  const override = process.env["NULLADRIFT_DOCS_URL"];
  return override !== undefined && override !== "" ? override.replace(/\/+$/, "") : BUILT_IN_DOCS_URL;
}

/** Where opt-in drift counts are sent. Telemetry is unavailable while this is undefined. */
const DEFAULT_TELEMETRY_ENDPOINT: string | undefined = undefined;

/**
 * Read per call rather than captured at import, so a test (or an operator running their own
 * collector) can point it somewhere without reloading the module graph.
 */
export function telemetryEndpoint(): string | undefined {
  const override = process.env["NULLADRIFT_TELEMETRY_ENDPOINT"];
  return override !== undefined && override !== "" ? override : DEFAULT_TELEMETRY_ENDPOINT;
}

export function helpUriFor(anchor: string): string | undefined {
  const base = publishedDocsUrl();
  return base === undefined ? undefined : `${base}/blob/main/docs/lockfile.md#${anchor}`;
}
