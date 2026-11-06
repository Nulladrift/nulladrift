/**
 * `nulladrift review` -- show what moved and accept it into the lock.
 *
 * Acceptance is per server, not per change. A server's entry carries one digest over its whole
 * surface, so accepting half of what a server now reports would write an entry that no server
 * ever served -- a lock that looks reviewed and matches nothing.
 */
import { createInterface } from "node:readline/promises";
import { steeringSignals, surfaceCapabilities, surfaceText } from "@nulladrift/core";
import { captureAll } from "../audit";
import { diffLockfiles } from "../diff";
import type { Change } from "../diff/types";
import { readLockfile, writeLockfile } from "../lock/io";
import type { Lockfile } from "../lock/types";
import { EXIT_CLEAN, EXIT_DRIFT, EXIT_INCOMPLETE, type ExitCode } from "../lib/exit";
import { bold, dim, elideMiddle, green, red, truncate, yellow } from "../lib/ui";
import type { CommonOptions } from "./options";


/**
 * What the surface being accepted can do, and what in it addresses the model.
 *
 * `init` prints this at the moment a surface is first approved and `check` prints it when
 * something arrives; between them sat the screen where a person actually says yes, which showed
 * neither. Accepting a tool that had just gained a `command` argument read "accepts input it did
 * not before" -- the same sentence as gaining an optional string -- and the signed record of that
 * approval said no more than the screen did.
 */
function describeSurface(subject: unknown, previous: unknown): string[] {
  if (typeof subject !== "object" || subject === null) return [];
  const entry = subject as NonNullable<Parameters<typeof surfaceText>[0]>;
  const lines: string[] = [];

  // Both of these coerce what they are given; see risk/untrusted in the engine.
  const capabilities = surfaceCapabilities(entry.tools);
  if (capabilities.length > 0) {
    const worst = capabilities.some((c) => c.severity === "critical" || c.severity === "high");
    const text = `  after accepting, this server can: ${capabilities.map((c) => c.kind).join(", ")}`;
    lines.push(worst ? yellow(text) : dim(text));
  }

  const had = new Set(
    (typeof previous === "object" && previous !== null
      ? surfaceText(previous as Parameters<typeof surfaceText>[0]).flatMap((piece) => steeringSignals(piece.text, piece.field))
      : []
    ).map((signal) => `${signal.field}\u0000${signal.kind}\u0000${signal.quote}`),
  );
  const steering = surfaceText(entry)
    .flatMap((piece) => steeringSignals(piece.text, piece.field))
    .filter((signal) => !had.has(`${signal.field}\u0000${signal.kind}\u0000${signal.quote}`));

  if (steering.length > 0) {
    lines.push(yellow(`  ${steering.length} new passage(s) here read as instructions to the model:`));
    const byField = new Map<string, string>();
    for (const signal of steering) if (!byField.has(signal.field)) byField.set(signal.field, signal.quote);
    for (const [field, quote] of [...byField].slice(0, 3)) {
      lines.push(dim(`      ${elideMiddle(field, 52)}: ${truncate(quote, 72)}`));
    }
  }
  return lines;
}

interface ReviewOptions extends CommonOptions {
  acceptAll: boolean;
}

function describe(change: Change): string {
  const head = `  ${change.severity === "high" ? red("●") : change.severity === "medium" ? yellow("●") : dim("●")} ${change.member ? `${bold(change.member)}: ` : ""}${change.summary}  ${dim(change.kind)}`;
  if (change.kind !== "tool.description.changed" && change.kind !== "server.instructions.changed") return head;
  const before = typeof change.before === "string" ? `\n      ${red(`- ${truncate(change.before, 220)}`)}` : "";
  const after = typeof change.after === "string" ? `\n      ${green(`+ ${truncate(change.after, 220)}`)}` : "";
  return `${head}${before}${after}`;
}

export async function runReview(options: ReviewOptions): Promise<ExitCode> {
  const committed = await readLockfile(options.lockPath);
  const result = await captureAll({
    projectRoot: options.projectRoot,
    configFiles: options.configFiles,
    timeoutMs: options.timeoutMs,
    policy: committed.policy,
    /*
     * What review writes is what gets committed. Without the previous lock, accepting a change
     * while a registry was unreachable would drop every artifact pin in the file -- and the next
     * run would re-pin whatever had been published since, with nothing to compare it against.
     */
    previous: committed,
    provenance: options.provenance,
  });

  const changes = diffLockfiles(committed, result.lock);
  if (changes.length === 0) {
    process.stdout.write(`${green(`✓ nothing to review; ${options.lockPath} is up to date`)}\n`);
    return result.unreachable.length > 0 && !options.allowUnreachable ? EXIT_INCOMPLETE : EXIT_CLEAN;
  }

  const grouped = new Map<string, Change[]>();
  for (const change of changes) {
    const bucket = grouped.get(change.server) ?? [];
    bucket.push(change);
    grouped.set(change.server, bucket);
  }

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!options.acceptAll && !interactive) {
    process.stderr.write(
      `${red("review needs a terminal.")} Run it locally, or pass --accept-all to take every change without reading it.\n`,
    );
    return EXIT_INCOMPLETE;
  }

  const next: Lockfile = { ...committed, subjects: { ...committed.subjects }, generatedBy: result.lock.generatedBy };
  const readline = options.acceptAll ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  let accepted = 0;
  let declined = 0;

  try {
    for (const [serverName, serverChanges] of grouped) {
      const context = describeSurface(result.lock.subjects[serverName], committed.subjects[serverName]);
      process.stdout.write(
        `\n${bold(serverName)}\n${serverChanges.map(describe).join("\n")}\n${context.length > 0 ? `${context.join("\n")}\n` : ""}`,
      );

      let take = options.acceptAll;
      if (readline) {
        const answer = (await readline.question(`\n  Accept these ${serverChanges.length} change(s) into the lock? [y/N] `)).trim().toLowerCase();
        take = answer === "y" || answer === "yes";
      }
      if (!take) {
        declined += 1;
        continue;
      }

      accepted += 1;
      const fresh = result.lock.subjects[serverName];
      if (fresh) next.subjects[serverName] = fresh;
      else delete next.subjects[serverName];

      // A rename leaves the old key behind; accepting the rename retires it.
      for (const change of serverChanges) {
        if (change.kind === "server.renamed" && typeof change.before === "string") delete next.subjects[change.before];
      }
    }
  } finally {
    readline?.close();
  }

  if (accepted > 0) {
    await writeLockfile(options.lockPath, next);
    process.stdout.write(`\n${green(`✓ accepted ${accepted} server(s) into ${options.lockPath}`)}\n`);
  }
  if (declined > 0) process.stdout.write(`${yellow(`${declined} server(s) left unaccepted; \`check\` will still fail on them.`)}\n`);

  if (result.unreachable.length > 0 && !options.allowUnreachable) return EXIT_INCOMPLETE;
  return declined > 0 ? EXIT_DRIFT : EXIT_CLEAN;
}
