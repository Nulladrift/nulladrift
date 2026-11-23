import { visibleControls } from "../lib/ui";
import type { FloatingRequest } from "../lock/provenance";
import type { FloatingServer } from "./types";

/**
 * What to say about a server configured with no exact version, and what to write instead.
 *
 * The same sentence in `init`, `check` and `push`, because it is about the configuration, which
 * is the same whichever command read it. It names the release that runs now when this run found
 * one, so taking the advice does not change which code runs today: the build stops moving when
 * upstream does, and moves again when somebody changes the version, in a pull request that says
 * so.
 *
 * The package name is the configuration's, so a pull request's, and the version is the
 * registry's. Both are escaped like any text this tool did not write.
 */
export function floatingLine(entry: FloatingRequest): string {
  const instead =
    entry.exact !== undefined
      ? `Write it as ${entry.exact}, which is what runs now.`
      : entry.ecosystem === "oci"
        ? `Write it by digest, as ${entry.name}@sha256:<digest>.`
        : `Write it with an exact version, as ${entry.name}${entry.ecosystem === "pypi" ? "==" : "@"}<version>.`;
  return visibleControls(
    `${entry.asked} runs whatever version was published last, so a new release can show up as drift, and fail the build, with no change to the config. ${instead}`,
  );
}

/** One note per server, for `push`, which has no report of its own to put them in. */
export function floatingNotes(floating: FloatingServer[]): string[] {
  return floating.map((entry) => `${visibleControls(entry.server)}: ${floatingLine(entry)}`);
}
