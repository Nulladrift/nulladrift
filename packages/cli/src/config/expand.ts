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
}

const PLACEHOLDER = /\$\{([^}]+)\}/g;

export function expand(input: string, context: ExpandContext): Expanded {
  const unresolved: string[] = [];

  const value = input.replace(PLACEHOLDER, (match, body: string) => {
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

  return { value, unresolved };
}

export function expandAll(inputs: string[], context: ExpandContext): Expanded {
  const results = inputs.map((input) => expand(input, context));
  return {
    value: results.map((result) => result.value).join("\u0000"),
    unresolved: results.flatMap((result) => result.unresolved),
  };
}
