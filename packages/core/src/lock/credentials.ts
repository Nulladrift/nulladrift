/**
 * Credentials a config writes literally, found so the lock can leave them out.
 *
 * Environment and header values were never written to the lock, only their names, and a URL
 * loses its query string and its user:password. That covered every place a credential belongs.
 * It did not cover the places configs actually put them: `--api-key sk-...` in `args`,
 * `-e GITHUB_TOKEN=ghp_...` in a `docker run`, a connection string with a password, a token as a
 * segment of a hosted server's URL. The lock is the file the README tells you to commit, and the
 * reading `push` sends is the same data, so each of those went into git and over the wire.
 *
 * A credential is replaced, not hashed. A rotated key is not a change to what a server can do,
 * so there is nothing for drift to see in it, and a hash of a short password is something a
 * dictionary can be run against. This matches what already happens to an `env` value.
 *
 * Everything here errs toward leaving a value alone. A false positive hides a real change to how
 * a server is started, which is the thing the lock exists to show; a value is only replaced when
 * its name says it is a credential, its issuer's format does, or it is too random to be anything
 * else. A `${VAR}` placeholder is never touched: that is how a config is supposed to do this.
 */

/** What a credential is replaced with. Plain ASCII, so it survives a URL path unescaped. */
export const REDACTED = "REDACTED";

/**
 * Names that mean the value is a credential: as a flag (`--github-token`), or as an environment
 * assignment inside an argument (`GITHUB_PERSONAL_ACCESS_TOKEN=...`). Matched as the last word of
 * the name, so `--max-tokens`, `--tokenizer` and `--password-file` are left alone.
 */
const CREDENTIAL_NAME =
  /(?:^|[-_.])(?:api[-_]?key|apikey|access[-_]?key|secret(?:[-_]?key)?|client[-_]?secret|token|access[-_]?token|auth[-_]?token|refresh[-_]?token|bearer|password|passwd|pass|pwd|private[-_]?key|credentials?)$/i;

/**
 * Formats a credential has wherever it appears, because its issuer made it recognisable on
 * purpose (so leaked ones can be found). Each is specific enough not to match a package name.
 */
const ISSUER_FORMATS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, // OpenAI
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

/** A value written as a placeholder for the client to fill in, which is the safe way to do this. */
const PLACEHOLDER = /\$\{|^\$[A-Za-z_]/;

/**
 * A token with no issuer format: long, URL-safe, mixing upper case, lower case and digits, and
 * switching between them constantly.
 *
 * Requiring all three classes leaves out UUIDs, hex digests and commit hashes, which are lower
 * case and far more often an identifier than a secret. Requiring the switching leaves out long
 * names: `AnthropicClaudeDesktopExtension2025` has every class but changes class six times in
 * thirty-five characters, where a random token changes on most of them.
 */
function looksRandom(value: string): boolean {
  if (value.length < 32 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) return false;
  const kind = (character: string) => (/[a-z]/.test(character) ? 0 : /[A-Z]/.test(character) ? 1 : /[0-9]/.test(character) ? 2 : 3);
  let switches = 0;
  for (let index = 1; index < value.length; index += 1) {
    if (kind(value[index] ?? "") !== kind(value[index - 1] ?? "")) switches += 1;
  }
  return switches >= value.length / 3;
}

/** `decodeURIComponent`, for a check: a malformed escape is just text. */
function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A value worth replacing when its name already says it is a credential. */
function isSecretValue(value: string): boolean {
  if (value === "" || value === REDACTED || PLACEHOLDER.test(value)) return false;
  // A path or a URL names where the secret lives, not the secret: `--token-file`-style use.
  if (/^(?:[./~]|[A-Za-z]:\\|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)) return false;
  return true;
}

/** Replaces each issuer-formatted credential inside a value, leaving the rest of it readable. */
function redactFormats(value: string): string {
  let out = value;
  for (const format of ISSUER_FORMATS) out = out.replace(format, REDACTED);
  return out;
}

/** In a URL inside an argument: the password, and the value of any query parameter named as a credential. */
function redactUrl(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  if (url.password && !PLACEHOLDER.test(decoded(url.password))) {
    url.password = REDACTED;
    changed = true;
  }
  for (const [key, parameter] of [...url.searchParams]) {
    if (CREDENTIAL_NAME.test(key) && isSecretValue(parameter)) {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? url.toString() : value;
}

/**
 * `args` with every credential written literally in them replaced by {@link REDACTED}.
 *
 * Handles a flag and its value (`--api-key KEY`, `--api-key=KEY`), an environment assignment in
 * an argument (`-e GITHUB_TOKEN=ghp_...`, as `docker run` takes them), a URL's password or
 * credential query parameter, an issuer-formatted token anywhere, and an argument that is nothing
 * but a long random token. Arguments are returned in place and in order, so a change to anything
 * else about how a server is started is still drift.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out = [...args];
  for (let index = 0; index < out.length; index += 1) {
    const argument = out[index] ?? "";

    // `--name=value`, `-n=value`, and `NAME=value` (an environment assignment).
    const assignment = /^(-{0,2}[A-Za-z][A-Za-z0-9_.-]*)=(.*)$/s.exec(argument);
    if (assignment) {
      const [, name = "", value = ""] = assignment;
      if (CREDENTIAL_NAME.test(name.replace(/^-+/, "")) && isSecretValue(value)) {
        out[index] = `${name}=${REDACTED}`;
        continue;
      }
      // Any other assignment: its value can still hold a URL with a password, or a token.
      if (!PLACEHOLDER.test(value)) out[index] = `${name}=${looksRandom(value) ? REDACTED : redactFormats(redactUrl(value))}`;
      continue;
    }

    // `--name value`: the flag names a credential, so the next argument is one.
    const flag = /^-{1,2}([A-Za-z][A-Za-z0-9_.-]*)$/.exec(argument);
    const next = out[index + 1];
    if (flag && next !== undefined && !next.startsWith("-") && CREDENTIAL_NAME.test(flag[1] ?? "") && isSecretValue(next)) {
      out[index + 1] = REDACTED;
      index += 1;
      continue;
    }

    if (PLACEHOLDER.test(argument)) continue;
    if (looksRandom(argument)) {
      out[index] = REDACTED;
      continue;
    }
    out[index] = redactFormats(redactUrl(argument));
  }
  return out;
}

/**
 * A URL path with any segment that is a credential replaced, for hosted servers whose address
 * embeds the key (`https://host/api/<token>/mcp`). The rest of the path stays, so a server that
 * moves to a different path or host is still drift.
 */
export function redactPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "" || PLACEHOLDER.test(decoded(segment))) return segment;
      if (looksRandom(segment)) return REDACTED;
      return redactFormats(segment);
    })
    .join("/");
}

/** How many credentials were left out of a locked transport, for saying so. */
export function countRedacted(transport: { args?: readonly string[]; url?: string }): number {
  const occurrences = (text: string) => text.split(REDACTED).length - 1;
  return (transport.args ?? []).reduce((total, argument) => total + occurrences(argument), 0) + occurrences(transport.url ?? "");
}
