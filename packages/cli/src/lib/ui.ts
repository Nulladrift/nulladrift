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

/** Keeps a long description readable in a terminal without hiding that it was truncated. */
export function truncate(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}
