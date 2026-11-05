/**
 * What to print when the control plane refuses a reading.
 *
 * Every refusal used to print the same line: the status, then up to five hundred characters of
 * whatever the body happened to be, which for this API is a JSON envelope. So a tenant that had
 * run out of projects got `control plane answered 402: {"error":{"code":"plan_limit",...}}` and
 * had to read the message out of the punctuation.
 *
 * That matters most in the one case nobody is watching for. The project limit is checked only
 * when a reading names a project that does not exist yet, so the build that meets it is a brand
 * new repository's first build, run by somebody who has never seen this tool and has no reason
 * to suspect billing. Rolling the collector out through a shared CI template turns that into
 * every new service failing its first run, at the moment the rollout is working.
 *
 * The server already writes a good sentence for these: `overLimit` names the plan, the limit and
 * where to change it. The job here is to stop burying it.
 */

/** The envelope every error from the control plane uses. Absent or malformed is normal. */
interface ErrorEnvelope {
  code: string;
  message: string;
}

function envelope(body: string): ErrorEnvelope | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    const code = parsed.error?.code;
    const message = parsed.error?.message;
    if (typeof code !== "string" || typeof message !== "string") return null;
    return { code, message };
  } catch {
    // A proxy, a load balancer or a captive portal answering with HTML is not a bug worth a
    // stack trace. Fall back to printing what arrived.
    return null;
  }
}

export interface Refusal {
  /** The stderr text, without the trailing newline. */
  text: string;
  /**
   * Whether this is the tenant's plan rather than a fault.
   *
   * Separated because the two want different words: a plan limit is an administrative fact that
   * somebody can act on today, and everything else is the control plane saying no.
   */
  planLimit: boolean;
}

export function describeRefusal(status: number, body: string): Refusal {
  const error = envelope(body);

  if (status === 402 && error?.code === "plan_limit") {
    return {
      planLimit: true,
      text: [
        "this organization is at its plan limit, so the reading was not recorded",
        "",
        `  ${error.message}`,
        "",
        // Said plainly because the person reading it is usually not the person who can fix it,
        // and their first instinct will be that they broke the build.
        "Nothing is wrong with this build or with the servers it audited. An owner or admin of",
        "the organization can raise the limit, and the next push will record normally.",
      ].join("\n"),
    };
  }

  if (status === 401 || status === 403) {
    return {
      planLimit: false,
      text: `the control plane refused this token (${status}): ${error?.message ?? body.slice(0, 300)}`,
    };
  }

  // Anything else, including a body that is not our envelope at all.
  return {
    planLimit: false,
    text: `control plane answered ${status}: ${error?.message ?? body.slice(0, 500)}`,
  };
}
