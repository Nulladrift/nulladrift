/** Terminal output helpers. Colour is a courtesy, never a carrier of meaning. */
import { INVISIBLE_CHARACTERS } from "@nulladrift/core";

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
export function visibleControls(text: string, options: { multiline?: boolean } = {}): string {
  return text.replace(options.multiline ? CONTROLS_EXCEPT_LINES : CONTROLS, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/*
 * C0 and C1 controls and DEL, plus every character that changes what a line appears to say
 * without changing what it is (see INVISIBLE_CHARACTERS). Newline and tab included: a server
 * version of "1.0.1\n\n✓ 1 server(s) match mcp.lock" printed a fake verdict on a line of its own
 * in the middle of a real report. Text that is meant to span lines is split by its caller and
 * each line escaped with `multiline`.
 */
const CONTROLS = new RegExp(`[\\u0000-\\u001F\\u007F-\\u009F${INVISIBLE_CHARACTERS}]`, "gu");
const CONTROLS_EXCEPT_LINES = new RegExp(`[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F${INVISIBLE_CHARACTERS}]`, "gu");

/** Server text that may span lines, each line escaped and indented to sit under the first. */
export function visibleLines(text: string, indent: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => visibleControls(line))
    .join(`\n${indent}`);
}

/** Keeps a long description readable in a terminal without hiding that it was truncated. */
export function truncate(text: string, limit = 160): string {
  const collapsed = visibleControls(text, { multiline: true }).replace(/\s+/g, " ").trim();
  // By code point, so a character outside the BMP is never cut in half into a replacement mark.
  const points = [...collapsed];
  return points.length <= limit ? collapsed : `${points.slice(0, limit - 1).join("")}…`;
}

/**
 * A field path names a place to go and look, so both ends carry information: the head says which
 * tool and which argument, the tail says which leaf. Text buried twenty levels down produced a
 * path that wrapped over two lines and pushed the quote off the screen entirely, which is a way
 * of hiding in the report rather than in the schema.
 */
export function elideMiddle(raw: string, limit: number): string {
  // Field paths name a server's tools and parameters, so they are escaped like any server text.
  const path = visibleControls(raw);
  if (path.length <= limit) return path;
  const keep = Math.floor((limit - 1) / 2);
  return `${path.slice(0, keep)}\u2026${path.slice(-keep)}`;
}
