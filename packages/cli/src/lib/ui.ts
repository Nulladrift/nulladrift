/** Terminal output helpers. Colour is a courtesy, never a carrier of meaning. */
const enabled =
  process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb";

const wrap = (code: number) => (text: string) => (enabled ? `\u001B[${code}m${text}\u001B[0m` : text);

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);

/**
 * Makes server-controlled text safe to print, by making the dangerous parts visible.
 *
 * Every string this tool renders -- a tool description, a server's instructions, its name --
 * is written by the server under audit. A server that can control the terminal can hide the
 * finding from the person reading it. A description ending
 * `\u001b[2J\u001b[H\u001b[32m0 high · 0 medium · 0 low` clears the screen and repaints a clean
 * summary over the diff that was about to be read, which defeats the entire point of showing
 * somebody what changed.
 *
 * `truncate` collapsed `\s+`, which in JavaScript covers carriage return and so neutralised the
 * obvious overwrite trick, and does not cover ESC or any other C0 control character.
 *
 * These are escaped rather than stripped. A description that gains a zero-width space or a
 * right-to-left override has changed, and the reviewer is the one who should decide whether
 * that matters; deleting it quietly would hide a real difference in text that reaches a model.
 */
export function visibleControls(text: string): string {
  return text.replace(
    // C0 and C1 controls and DEL, plus the bidirectional overrides and zero-width characters
    // that change what a line appears to say without changing what it is.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Keeps a long description readable in a terminal without hiding that it was truncated. */
export function truncate(text: string, limit = 160): string {
  const collapsed = visibleControls(text).replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * A field path names a place to go and look, so both ends carry information: the head says which
 * tool and which argument, the tail says which leaf. Text buried twenty levels down produced a
 * path that wrapped over two lines and pushed the quote off the screen entirely, which is a way
 * of hiding in the report rather than in the schema.
 */
export function elideMiddle(path: string, limit: number): string {
  if (path.length <= limit) return path;
  const keep = Math.floor((limit - 1) / 2);
  return `${path.slice(0, keep)}\u2026${path.slice(-keep)}`;
}
