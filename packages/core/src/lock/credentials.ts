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
 * Whether a name says its value is a credential: a flag (`--github-token`, `--key`), an
 * environment assignment (`GITHUB_PAT=`, `DD_API_KEY_SECONDARY=`), a JSON key (`braveApiKey`), a
 * query or connection-string parameter (`api_key=`, `Password=`).
 *
 * Read as words, camelCase split, so the credential word can sit anywhere in the name. It was a
 * suffix match, which missed `--key`, `GITHUB_PAT`, `braveApiKey` and every name with a word after
 * the credential one. A name whose last word says it holds something *about* a credential (where
 * it is, what kind it is) is left alone: `--token-file`, `--key-id`, `--auth-type`, `--max-tokens`.
 */
const CREDENTIAL_WORDS = new Set([
  "key", "apikey", "token", "secret", "password", "passwd", "pwd", "pass", "pat", "auth", "bearer",
  "credential", "credentials", "privatekey", "accesskey", "clientsecret", "sig", "signature", "jwt", "cookie",
]);
const DESCRIBES_IT = new Set([
  "file", "path", "dir", "directory", "url", "uri", "endpoint", "host", "type", "mode", "method", "header",
  "name", "id", "env", "var", "length", "limit", "count", "max", "min", "size", "timeout", "ttl", "format",
  "prefix", "location", "store", "provider", "region", "scope", "scopes", "version", "algorithm", "kind", "expiry",
]);

function nameWords(name: string): string[] {
  return name
    .replace(/^-+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isCredentialName(name: string): boolean {
  const words = nameWords(name);
  const last = words[words.length - 1];
  if (last === undefined || DESCRIBES_IT.has(last) || words[0] === "no") return false;
  return words.some((word) => CREDENTIAL_WORDS.has(word));
}

/** Headers that carry a credential whatever their value looks like. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

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

/*
 * Hosts that serve code from a path naming what it is: a commit (`/acme/server/1f2e...4c/main.ts`),
 * a gist, a tarball of a ref. The long hex segment there is the version being run, not a key, and
 * replacing it made a launcher that swapped one commit for another compare clean. Credentials on
 * these hosts travel in the query or the userinfo, which are still redacted, as is any segment in
 * an issuer's credential format.
 */
const CODE_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "api.github.com",
  "gitlab.com",
  "bitbucket.org",
  "cdn.jsdelivr.net",
  "esm.sh",
  "deno.land",
]);

/** In a URL inside an argument: the password, credential parameters in the query or fragment, key path segments. */
function redactUrl(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return redactPairs(value);
  }
  let changed = false;
  if (url.password && !PLACEHOLDER.test(decoded(url.password))) {
    url.password = REDACTED;
    changed = true;
  }
  for (const [key, parameter] of [...url.searchParams]) {
    if (isCredentialName(key) && isSecretValue(parameter)) {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  const path = redactPath(url.pathname, { contentAddressed: CODE_HOSTS.has(url.hostname.toLowerCase()) });
  if (path !== url.pathname) {
    url.pathname = path;
    changed = true;
  }
  const hash = url.hash ? redactPairs(url.hash) : url.hash;
  if (hash !== url.hash) {
    url.hash = hash;
    changed = true;
  }
  return changed ? url.toString() : value;
}

/**
 * `name=value` pairs inside a larger string whose name is a credential: a query string a URL
 * parser would not take (`jdbc:postgresql://...&password=`), a fragment (`#access_token=`), a
 * connection string (`Server=db;Password=...`).
 */
function redactPairs(text: string): string {
  return text.replace(/(^|[?&;#\s,])([A-Za-z_][A-Za-z0-9_.-]*)=([^&;#\s,]*)/g, (whole, lead: string, name: string, value: string) =>
    isCredentialName(name) && isSecretValue(value) ? `${lead}${name}=${REDACTED}` : whole,
  );
}

/** A header written as `Name: value`, for a header that is a credential. */
function redactHeader(text: string): string | undefined {
  const header = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(\S.*)$/s.exec(text);
  if (!header) return undefined;
  const [, name = "", value = ""] = header;
  if (!(CREDENTIAL_HEADERS.has(name.toLowerCase()) || isCredentialName(name)) || PLACEHOLDER.test(value)) return undefined;
  return `${name}: ${REDACTED}`;
}

/** JSON in an argument (`--config {"braveApiKey":"..."}`), its credential-named values replaced. */
function redactJson(text: string): string | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === "string" && isCredentialName(key) && isSecretValue(child)) {
          out[key] = REDACTED;
          changed = true;
        } else if (typeof child === "string") {
          const next = redactText(child);
          if (next !== child) changed = true;
          out[key] = next;
        } else {
          out[key] = walk(child);
        }
      }
      return out;
    }
    return node;
  };
  const result = walk(parsed);
  return changed ? JSON.stringify(result) : undefined;
}

/** Everything that can hide a credential inside one string, in the order that keeps the rest readable. */
function redactText(text: string): string {
  if (PLACEHOLDER.test(text) && !/[?&;#]/.test(text)) return text;
  if (looksRandom(text)) return REDACTED;
  const json = redactJson(text);
  if (json !== undefined) return json;
  const header = redactHeader(text);
  if (header !== undefined) return header;
  return redactFormats(redactPairs(redactUrl(text)));
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
      if (isCredentialName(name) && isSecretValue(value)) {
        out[index] = `${name}=${REDACTED}`;
        continue;
      }
      // Any other assignment: its value can still hold a header, a URL with a password, JSON, a token.
      if (!PLACEHOLDER.test(value) || /[?&;#]/.test(value)) out[index] = `${name}=${redactText(value)}`;
      continue;
    }

    // `--name value`: the flag names a credential, so the next argument is one.
    const flag = /^-{1,2}([A-Za-z][A-Za-z0-9_.-]*)$/.exec(argument);
    const next = out[index + 1];
    if (flag && next !== undefined && !next.startsWith("-")) {
      const name = flag[1] ?? "";
      if (isCredentialName(name) && isSecretValue(next) && !looksLikeAnOperand(next)) {
        out[index + 1] = REDACTED;
        index += 1;
        continue;
      }
      // `-u user:password`, `--user user:password`: curl's form, and every tool that copied it.
      if (["u", "user", "basic-auth"].includes(name.toLowerCase()) && /^[^:\s]+:[^\s]+$/.test(next) && !PLACEHOLDER.test(next)) {
        out[index + 1] = `${next.slice(0, next.indexOf(":"))}:${REDACTED}`;
        index += 1;
        continue;
      }
    }

    out[index] = redactText(argument);
  }
  return out;
}

/**
 * Whether the word after a flag is more likely the next operand than the flag's value: a script, a
 * package, a path. A boolean credential flag (`--auth`) followed by `server.js` is not a key.
 */
function looksLikeAnOperand(value: string): boolean {
  return value.startsWith("@") || value.includes("/") || /\.(m?[jt]s|cjs|py|json|ya?ml|toml|sh|exe)$/i.test(value);
}

/**
 * A URL path with any segment that is a credential replaced, for hosted servers whose address
 * embeds the key (`https://host/api/<token>/mcp`). The rest of the path stays, so a server that
 * moves to a different path or host is still drift.
 */
export function redactPath(pathname: string, options: { contentAddressed?: boolean } = {}): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "" || PLACEHOLDER.test(decoded(segment))) return segment;
      if (looksRandom(segment)) return REDACTED;
      // A UUID or a long hex string in a hosted server's address is its key far more often than
      // not (Pipedream, Composio and the like put the account's key there). On a code host it is
      // a commit or a gist, and it is the thing being pinned.
      if (
        !options.contentAddressed &&
        (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) || /^[0-9a-f]{32,}$/i.test(segment))
      )
        return REDACTED;
      return redactFormats(segment);
    })
    .join("/");
}

/** How many credentials were left out of a locked transport, for saying so. */
export function countRedacted(transport: { args?: readonly string[]; url?: string }): number {
  const occurrences = (text: string) => text.split(REDACTED).length - 1;
  return (transport.args ?? []).reduce((total, argument) => total + occurrences(argument), 0) + occurrences(transport.url ?? "");
}
