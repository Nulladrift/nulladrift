/**
 * What actually went wrong when a remote server could not be reached.
 *
 * Node's fetch reports every network failure as "fetch failed" and keeps the reason in `cause`,
 * sometimes two levels down, sometimes inside an AggregateError when it tried more than one
 * address. The SDK wraps that again, so a server that was simply not running was reported as
 * "Version negotiation probe failed: fetch failed" -- true, and no help to whoever has to fix it.
 * Found by using the product: the first question on reading it was whether the URL, the network
 * or the server was wrong, and nothing in the message said.
 *
 * Only the host and port are named, never a path or a query: this reason is sent to the control
 * plane by `push`, and a URL's path is where people put tokens.
 */

interface NetworkError {
  code: string;
  address?: string;
  port?: number;
  hostname?: string;
}

const MAX_DEPTH = 8;

/** The first error in the chain that carries a network code, or nothing. */
function networkError(error: unknown): NetworkError | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  while (pending.length > 0) {
    const { value, depth } = pending.shift()!;
    if (value === null || typeof value !== "object" || depth > MAX_DEPTH) continue;
    const candidate = value as { code?: unknown; address?: unknown; port?: unknown; hostname?: unknown; cause?: unknown; errors?: unknown };
    if (typeof candidate.code === "string" && /^(E[A-Z]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|UNABLE_TO_[A-Z_]+|[A-Z_]*SELF_SIGNED[A-Z_]*)$/.test(candidate.code)) {
      return {
        code: candidate.code,
        address: typeof candidate.address === "string" ? candidate.address : undefined,
        port: typeof candidate.port === "number" ? candidate.port : undefined,
        hostname: typeof candidate.hostname === "string" ? candidate.hostname : undefined,
      };
    }
    pending.push({ value: candidate.cause, depth: depth + 1 });
    if (Array.isArray(candidate.errors)) for (const inner of candidate.errors.slice(0, 8)) pending.push({ value: inner, depth: depth + 1 });
  }
  return undefined;
}

/** `host:port`, bracketing an IPv6 address, or nothing when neither is known. */
function where(found: NetworkError): string {
  const host = found.hostname ?? found.address;
  if (!host) return "";
  const shown = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return found.port !== undefined ? `${shown}:${found.port}` : shown;
}

/**
 * The cause in words a person can act on, or nothing when the chain holds no network code -- in
 * which case the message as it stands is the best there is.
 */
export function describeNetworkFailure(error: unknown): string | undefined {
  const found = networkError(error);
  if (!found) return undefined;
  const at = where(found);
  switch (found.code) {
    case "ECONNREFUSED":
      return `connection refused${at ? ` by ${at}` : ""}: nothing is listening there. Is the server running, and is the port right?`;
    case "ENOTFOUND":
      return `${at ? `the host name ${found.hostname ?? at}` : "the host name"} does not resolve. Check the URL for a typo, or the DNS this machine uses.`;
    case "EAI_AGAIN":
      return `looking up ${found.hostname ?? "the host name"} failed for now (EAI_AGAIN): DNS did not answer. Try again, or check this machine's network.`;
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `connecting${at ? ` to ${at}` : ""} timed out. A firewall may be dropping the traffic, or the host is down.`;
    case "ECONNRESET":
    case "UND_ERR_SOCKET":
      return `the connection${at ? ` to ${at}` : ""} was dropped before the server answered.`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `there is no route to ${at || "the host"} from this machine (${found.code}).`;
    default:
      if (/CERT|TLS|SELF_SIGNED|UNABLE_TO/.test(found.code)) {
        return `the server's TLS certificate was not accepted (${found.code}). Fix the certificate, or set NODE_EXTRA_CA_CERTS to the CA that signed it.`;
      }
      return `${found.code}${at ? ` at ${at}` : ""}`;
  }
}
