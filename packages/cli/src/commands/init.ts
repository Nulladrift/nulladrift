/** `nulladrift init` -- discover servers, capture their surface, write the lock. */
import { steeringSignals, surfaceCapabilities, surfaceText } from "@nulladrift/core";
import { describeSearch } from "../config/discover";
import { lstat } from "node:fs/promises";
import { captureAll } from "../audit";
import { writeLockfile } from "../lock/io";
import { EXIT_CLEAN, EXIT_INCOMPLETE, type ExitCode } from "../lib/exit";
import { bold, dim, elideMiddle, green, red, truncate, yellow } from "../lib/ui";
import { maybeOfferTelemetry } from "./telemetry";
import type { CommonOptions } from "./options";

export interface InitOptions extends CommonOptions {
  /** Replace a lockfile that already exists, instead of refusing. */
  force?: boolean;
}

/**
 * `lstat`, not `access`: a dangling symlink is something, and `access` says it is nothing.
 *
 * A repository shipping `mcp.lock` as a link to a file that does not exist yet reported "no
 * lockfile here", pinned, and created the link's target -- outside the project, without
 * `--force`, and announced as success.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(options: InitOptions): Promise<ExitCode> {
  /*
   * Checked before anything is captured: re-pinning is a decision about a file that already
   * exists, so it should not cost a round trip to every server first. `review` refuses to accept
   * changes nobody read unless --accept-all says otherwise; a second `init` would take the same
   * changes through a door with no prompt on it, which is why this one is here.
   */
  if (!options.force && (await exists(options.lockPath))) {
    process.stderr.write(
      [
        red(`${options.lockPath} already exists.`),
        dim("init would replace the reviewed baseline with whatever the servers answer right now."),
        "",
        `  nulladrift check          ${dim("see what moved")}`,
        `  nulladrift review         ${dim("read each change and accept it")}`,
        `  nulladrift init --force   ${dim("discard the existing lock and pin again from scratch")}`,
        "",
      ].join("\n"),
    );
    return EXIT_INCOMPLETE;
  }

  const result = await captureAll({
    projectRoot: options.projectRoot,
    configFiles: options.configFiles,
    timeoutMs: options.timeoutMs,
  });

  const names = Object.keys(result.lock.subjects);
  if (names.length === 0 && result.unreachable.length === 0) {
    process.stderr.write(
      [
        "No MCP servers found.",
        dim("Looked in:"),
        dim(describeSearch(result.discovery.searched, result.discovery.filesRead)),
        dim("Nothing was written. `nulladrift check` needs a lockfile, so it will fail until a"),
        dim("config declaring at least one server exists."),
        "",
      ].join("\n"),
    );
    return EXIT_CLEAN;
  }

  /*
   * An empty lock is worse than no lock. It pins nothing, and `init` refuses to run over an
   * existing lockfile, so writing one after every server failed leaves the next `init` blocked on
   * a baseline that never contained anything. Found when a server whose entry point had not been
   * built failed to start: the run reported "Pinned 0 server(s)", wrote the file, and told the
   * operator to commit it.
   */
  const pinnedSomething = names.length > 0;
  if (pinnedSomething) await writeLockfile(options.lockPath, result.lock);

  const lines: string[] = pinnedSomething
    ? ["", bold(`Pinned ${names.length} server(s) to ${options.lockPath}:`), ""]
    : ["", bold("Pinned nothing: no server answered."), ""];
  for (const name of names) {
    const entry = result.lock.subjects[name];
    const counts = [
      `${entry?.tools?.length ?? 0} tools`,
      `${entry?.resources?.length ?? 0} resources`,
      `${entry?.resourceTemplates?.length ?? 0} templates`,
      `${entry?.prompts?.length ?? 0} prompts`,
    ].join(", ");
    lines.push(`  ${green("✓")} ${bold(name)}  ${dim(counts)}`);
    const deprecated = entry?.transport.type === "sse" ? " · HTTP+SSE transport is deprecated in the spec" : "";
    lines.push(`      ${dim(`${entry?.protocol.era}/${entry?.protocol.version} · from ${entry?.source.file}${deprecated}`)}`);

    /*
     * What is being approved, at the moment of approving it. The counts say how much surface
     * there is; they do not say that one of those tools takes a `command` argument. The drift
     * report already explains an escalation after the fact -- "may now reach external systems" --
     * and saying nothing at the point of consent was the asymmetry.
     */
    const tools = (entry?.tools ?? []) as Array<{ name?: string; inputSchema?: unknown; description?: string }>;
    const capabilities = surfaceCapabilities(tools);
    if (capabilities.length > 0) {
      const worst = capabilities.filter((capability) => capability.severity === "critical" || capability.severity === "high");
      const paint = worst.length > 0 ? yellow : dim;
      lines.push(`      ${paint(`can: ${capabilities.map((capability) => capability.kind).join(", ")}`)}`);
      for (const capability of worst) {
        lines.push(`        ${dim(`${capability.kind} · ${capability.tools.slice(0, 3).join(", ")}${capability.tools.length > 3 ? ` +${capability.tools.length - 3}` : ""}`)}`);
      }
    }

    /*
     * Every field a model is shown, not the two that were easiest to reach. Scanning only
     * `description` and `instructions` covered 509 of the 2257 model-facing strings in a crawl
     * of 56 published servers, and missed the largest of them entirely: schema property
     * descriptions, which is how a model is told what to put in a parameter.
     */
    const steering = (entry ? surfaceText(entry as Parameters<typeof surfaceText>[0]) : []).flatMap((piece) =>
      steeringSignals(piece.text, piece.field),
    );
    if (steering.length > 0) {
      /*
       * Grouped by field, because the field is what a reviewer acts on: it says which part of
       * the server is talking to the model. Taking the first three signals instead printed three
       * lines from one noisy title and said nothing about the other four fields carrying the
       * same planted sentence.
       */
      const byField = new Map<string, string[]>();
      for (const signal of steering) byField.set(signal.field, [...(byField.get(signal.field) ?? []), signal.quote]);
      const fields = [...byField];
      lines.push(
        `      ${yellow(`${fields.length} field(s) carry text read as instructions to the model, not documentation:`)}`,
      );
      for (const [field, quotes] of fields.slice(0, 4)) {
        const more = quotes.length > 1 ? dim(` (+${quotes.length - 1} more here)`) : "";
        lines.push(`        ${dim(`${elideMiddle(field, 52)}: ${truncate(quotes[0] ?? "", 72)}`)}${more}`);
      }
      if (fields.length > 4) lines.push(`        ${dim(`+${fields.length - 4} more field(s)`)}`);
      lines.push(`        ${dim("A signal to read, not a verdict. It never fails a build.")}`);
    }
  }

  for (const failure of result.unreachable) {
    lines.push(`  ${red("✗")} ${bold(failure.server)}  ${dim("not pinned")}`, `      ${failure.reason}`);
  }

  for (const shadow of result.discovery.shadowed) {
    lines.push(dim(`  note: "${shadow.name}" is defined in both ${shadow.keptFrom} and ${shadow.alsoIn}; kept the first.`));
  }

  lines.push(
    "",
    pinnedSomething
      ? dim("Commit mcp.lock. `nulladrift check` in CI will fail if any of this changes.")
      : dim("No lockfile was written. Fix the server(s) above and run `nulladrift init` again."),
    "",
  );
  process.stdout.write(lines.join("\n"));

  await maybeOfferTelemetry();

  if (result.unreachable.length > 0 && !options.allowUnreachable) return EXIT_INCOMPLETE;
  return EXIT_CLEAN;
}
