import { countRedacted } from "../lock/credentials";
import type { Lockfile } from "../lock/types";

/**
 * What to say when a config wrote a credential literally and the lock left it out (redactArgs,
 * redactPath). Said, not just done: the value is still in the config file, which may be committed
 * too, and an mcp.lock committed before this release may already hold it. Rotating is the only
 * fix for a secret that reached git, so the line says so rather than leaving it to be guessed.
 */
export function redactedLine(count: number): string {
  const values = count === 1 ? "1 value that looks like a credential is" : `${count} values that look like credentials are`;
  return `${values} left out of the lock. Write each as \${VAR} instead, and rotate any an earlier mcp.lock committed.`;
}

/** One note per server whose locked transport had something left out, for `check` and `push`. */
export function redactedNotes(lock: Lockfile): string[] {
  return Object.entries(lock.subjects).flatMap(([name, entry]) => {
    const count = countRedacted(entry.transport as { args?: string[]; url?: string });
    return count > 0 ? [`${name}: ${redactedLine(count)}`] : [];
  });
}
