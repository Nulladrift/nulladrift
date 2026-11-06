/**
 * Every string in a declared surface that a model is shown.
 *
 * The steering scan originally read a tool's `description` and the server's `instructions`, which
 * is 509 of the 2257 model-facing strings in a crawl of 56 published servers. The largest single
 * field was not among them: schema property descriptions, 1311 of them, which is how a model is
 * told what to put in a parameter and therefore text it acts on.
 *
 * Moving the same sentence from `description` into `properties.path.description` produced no
 * finding at all, so the check was one keystroke away from being decorative. Scanning a subset of
 * the places text reaches the model is not a weaker version of the control; against anybody who
 * reads the source it is none of it.
 */

import { objectsIn, stringOr } from "./untrusted";

export interface SurfaceText {
  /** Where it was found, precise enough to go and look: `read_file.inputSchema.path`. */
  field: string;
  text: string;
}

/*
 * Schemas are attacker-supplied, so the walk is bounded -- but not by depth. A depth ceiling is
 * itself an evasion window: text at one level below it still reaches the model, so a bound of 8
 * is an instruction to nest nine deep. The deepest description in a crawl of 56 published
 * servers sits at depth 4, and nothing legitimate needs hundreds of nodes beyond that.
 *
 * So the limit is total work instead, which nesting cannot buy its way around, and the walk is
 * iterative so that a schema nested a million deep is a budget that runs out rather than a stack
 * that overflows. `seen` stops a self-referencing schema from spending the whole budget on one
 * cycle.
 */
const MAX_NODES = 20_000;

function schemaText(root: unknown, rootPath: string, out: SurfaceText[]): void {
  const stack: Array<{ node: unknown; path: string }> = [{ node: root, path: rootPath }];
  const seen = new WeakSet<object>();
  let budget = MAX_NODES;

  while (stack.length > 0 && budget-- > 0) {
    const { node, path } = stack.pop() as { node: unknown; path: string };
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const schema = node as { description?: unknown; title?: unknown; properties?: unknown; items?: unknown };
    if (typeof schema.description === "string") out.push({ field: path, text: schema.description });
    if (typeof schema.title === "string") out.push({ field: `${path}.title`, text: schema.title });

    const properties = schema.properties;
    if (typeof properties === "object" && properties !== null) {
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        stack.push({ node: child, path: `${path}.${name}` });
      }
    }
    if (schema.items !== undefined) stack.push({ node: schema.items, path: `${path}[]` });
  }
}

interface Describable {
  name?: string;
  title?: string;
  description?: string;
}

/** Every model-facing string in one locked server, with the field it came from. */
export function surfaceText(subject: ({
  instructions?: string;
  tools?: ReadonlyArray<Describable & { inputSchema?: unknown; outputSchema?: unknown }>;
  prompts?: ReadonlyArray<Describable & { arguments?: ReadonlyArray<Describable> }>;
  resources?: ReadonlyArray<Describable & { uri?: string }>;
  resourceTemplates?: ReadonlyArray<Describable & { uriTemplate?: string }>;
}) | null | undefined): SurfaceText[] {
  const out: SurfaceText[] = [];
  const push = (field: string, text: unknown): void => {
    if (typeof text === "string" && text.length > 0) out.push({ field, text });
  };

  push("instructions", subject?.instructions);

  for (const tool of objectsIn(subject?.tools)) {
    const where = stringOr(tool.name) ?? "?";
    push(`${where}.title`, tool.title);
    push(`${where}.description`, tool.description);
    schemaText(tool.inputSchema, `${where}.inputSchema`, out);
    schemaText(tool.outputSchema, `${where}.outputSchema`, out);
  }

  for (const prompt of objectsIn(subject?.prompts)) {
    const where = stringOr(prompt.name) ?? "?";
    push(`prompt:${where}.title`, prompt.title);
    push(`prompt:${where}.description`, prompt.description);
    for (const argument of objectsIn(prompt.arguments)) {
      push(`prompt:${where}.${stringOr(argument.name) ?? "?"}`, argument.description);
    }
  }

  for (const resource of objectsIn(subject?.resources)) {
    const where = stringOr(resource.name) ?? stringOr(resource.uri) ?? "?";
    push(`resource:${where}.title`, resource.title);
    push(`resource:${where}.description`, resource.description);
  }

  for (const template of objectsIn(subject?.resourceTemplates)) {
    const where = stringOr(template.name) ?? stringOr(template.uriTemplate) ?? "?";
    push(`template:${where}.title`, template.title);
    push(`template:${where}.description`, template.description);
  }

  return out;
}
