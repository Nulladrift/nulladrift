/**
 * Exit codes. CI has to be able to tell "it changed" from "I could not look".
 *
 * When both happen at once, incomplete wins: an audit that could not reach every server cannot
 * claim the drift it found is the only drift there is. Both are reported in the output.
 */
export const EXIT_CLEAN = 0;
export const EXIT_DRIFT = 1;
export const EXIT_INCOMPLETE = 2;

export type ExitCode = typeof EXIT_CLEAN | typeof EXIT_DRIFT | typeof EXIT_INCOMPLETE;

export function resolveExitCode(options: { driftCount: number; incompleteCount: number }): ExitCode {
  if (options.incompleteCount > 0) return EXIT_INCOMPLETE;
  if (options.driftCount > 0) return EXIT_DRIFT;
  return EXIT_CLEAN;
}
