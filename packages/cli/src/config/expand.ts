/**
 * Variable expansion in client configs.
 *
 * Every client invented its own syntax on top of JSON. Claude Code does `${VAR}` and
 * `${VAR:-default}`; VS Code adds `${workspaceFolder}`, `${userHome}` and `${input:id}`. We
 * resolve what can be resolved from the environment and report the rest by name, because a
 * placeholder we silently left in a command line turns into a confusing spawn failure three
 * layers down.
 */
import { homedir } from "node:os";

export interface ExpandContext {
  workspaceFolder: string;
  env: Record<string, string | undefined>;
}

export interface Expanded {
  value: string;
  /** Placeholders we could not fill, named as they appeared. */
  unresolved: string[];
  /** Placeholders naming this run's own credentials, which are never filled. See `isRunCredential`. */
  refused: string[];
}

const PLACEHOLDER = /\$\{([^}]+)\}/g;

/**
 * Variables that hold the credentials of the run doing the audit, never a server's.
 *
 * The config is the thing under review, and in a pull request it is the author's. Expanding
 * `${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` into a URL, a header or a server's environment handed the
 * job's identity to a host the author named, and `${NULLADRIFT_TOKEN}` handed over the collector
 * token. No MCP server needs either, so they are refused rather than filled, and the server is
 * reported as an audit that could not complete.
 *
 * What is refused is what nobody put there for a server: the credentials a CI provider injects
 * into every job, and every `NULLADRIFT_` variable. `${GITHUB_TOKEN}` and `${API_KEY}` are filled.
 * A workflow sets those on purpose, the GitHub MCP server is audited with the first, and keeping
 * them from a pull request's author is the workflow's job: run `check` on `pull_request`, which
 * gives a fork no secrets, and never on `pull_request_target`.
 */
const RUN_CREDENTIALS = new Set([
  "CI_JOB_TOKEN", "CI_REGISTRY_PASSWORD", "CI_DEPLOY_PASSWORD", "CI_DEPENDENCY_PROXY_PASSWORD", "CI_REPOSITORY_URL",
  "BUILDKITE_AGENT_ACCESS_TOKEN", "BITBUCKET_STEP_OIDC_TOKEN", "SYSTEM_ACCESSTOKEN",
]);

export function isRunCredential(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    RUN_CREDENTIALS.has(upper) ||
    upper.startsWith("NULLADRIFT_") ||
    upper.startsWith("ACTIONS_") ||
    upper.startsWith("CI_JOB_JWT") ||
    upper.startsWith("CIRCLE_OIDC_TOKEN")
  );
}

export function expand(input: string, context: ExpandContext): Expanded {
  const unresolved: string[] = [];
  const refused: string[] = [];

  const value = input.replace(PLACEHOLDER, (match, body: string) => {
    // `${NAME}`, `${env:NAME}` and `${NAME:-default}` all read NAME, so all three are refused.
    const named = body.startsWith("env:") ? body.slice(4) : body.includes(":-") ? body.slice(0, body.indexOf(":-")) : body;
    if (isRunCredential(named)) {
      refused.push(match);
      return match;
    }

    if (body === "workspaceFolder") return context.workspaceFolder;
    if (body === "userHome") return homedir();
    if (body === "pathSeparator" || body === "/") return "/";

    if (body.startsWith("input:") || body.startsWith("command:")) {
      /*
       * These are resolved by the host editor -- by prompting the user, or by running a command
       * inside it. An auditor has neither, and guessing a value would pin a surface nobody uses.
       */
      unresolved.push(match);
      return match;
    }

    if (body.startsWith("env:")) {
      const name = body.slice(4);
      const found = context.env[name];
      if (found !== undefined) return found;
      unresolved.push(match);
      return match;
    }

    const defaultAt = body.indexOf(":-");
    if (defaultAt !== -1) {
      const name = body.slice(0, defaultAt);
      return context.env[name] ?? body.slice(defaultAt + 2);
    }

    const found = context.env[body];
    if (found !== undefined) return found;
    unresolved.push(match);
    return match;
  });

  return { value, unresolved, refused };
}

export function expandAll(inputs: string[], context: ExpandContext): Expanded {
  const results = inputs.map((input) => expand(input, context));
  return {
    value: results.map((result) => result.value).join("\u0000"),
    unresolved: results.flatMap((result) => result.unresolved),
    refused: results.flatMap((result) => result.refused),
  };
}
