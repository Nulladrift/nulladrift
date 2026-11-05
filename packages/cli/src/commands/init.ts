/** `nulladrift init` -- discover servers, capture their surface, write the lock. */
import { access } from "node:fs/promises";
import { captureAll } from "../audit";
import { writeLockfile } from "../lock/io";
import { EXIT_CLEAN, EXIT_INCOMPLETE, type ExitCode } from "../lib/exit";
import { bold, dim, green, red } from "../lib/ui";
import { maybeOfferTelemetry } from "./telemetry";
import type { CommonOptions } from "./options";

export interface InitOptions extends CommonOptions {
  /** Replace a lockfile that already exists, instead of refusing. */
  force?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
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
      `No MCP servers found.\n${dim(`Looked in: ${result.discovery.filesRead.length > 0 ? result.discovery.filesRead.join(", ") : "no client config files exist for this project"}`)}\n`,
    );
    return EXIT_CLEAN;
  }

  await writeLockfile(options.lockPath, result.lock);

  const lines: string[] = ["", bold(`Pinned ${names.length} server(s) to ${options.lockPath}:`), ""];
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
  }

  for (const failure of result.unreachable) {
    lines.push(`  ${red("✗")} ${bold(failure.server)}  ${dim("not pinned")}`, `      ${failure.reason}`);
  }

  for (const shadow of result.discovery.shadowed) {
    lines.push(dim(`  note: "${shadow.name}" is defined in both ${shadow.keptFrom} and ${shadow.alsoIn}; kept the first.`));
  }

  lines.push("", dim("Commit mcp.lock. `nulladrift check` in CI will fail if any of this changes."), "");
  process.stdout.write(lines.join("\n"));

  await maybeOfferTelemetry();

  if (result.unreachable.length > 0 && !options.allowUnreachable) return EXIT_INCOMPLETE;
  return EXIT_CLEAN;
}
