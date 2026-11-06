/**
 * Text that started addressing the model since the surface was approved.
 *
 * The scan at pin time asks a person to read what they are about to approve. That covers the
 * surface as it was approved and nothing after it, which is the wrong half: the rug pull
 * (CVE-2025-54136) is defined by being clean at approval and changing afterwards. A server that
 * ships honest descriptions, gets pinned, and then rewrites one is the case the control exists
 * for, and it was the case the control did not see.
 *
 * `check` already fails on that change -- the text moved, so it is drift -- but it reported
 * `tool.description.changed` and left a reviewer to notice for themselves that the new text is
 * an instruction. Saying the text moved is not the same as saying what it now says.
 *
 * This is deliberately a difference and not a scan of the whole surface. Signals already present
 * when the lock was approved were shown at `init` and were accepted by somebody; repeating them
 * on every build is how a signal becomes noise that gets muted, and three of the three findings
 * across 56 published servers were benign prose. What is new is news.
 */
import type { Lockfile } from "../lock/types";
import { steeringSignals, type SteeringSignal } from "./steering";
import { surfaceText } from "./surface-text";

export interface ServerSteering {
  server: string;
  signals: SteeringSignal[];
}

/** Identity of a finding, so the same sentence in the same field is not reported as new. */
function identity(signal: SteeringSignal): string {
  return `${signal.field}\u0000${signal.kind}\u0000${signal.quote}`;
}

function signalsFor(subject: unknown): SteeringSignal[] {
  if (typeof subject !== "object" || subject === null) return [];
  return surfaceText(subject as Parameters<typeof surfaceText>[0]).flatMap((piece) =>
    steeringSignals(piece.text, piece.field),
  );
}

/**
 * Signals in `observed` that were not in `committed`, per server.
 *
 * A server absent from the committed lock is entirely new, so everything it says is new.
 */
export function newSteering(committed: Lockfile, observed: Lockfile): ServerSteering[] {
  const found: ServerSteering[] = [];

  for (const [server, subject] of Object.entries(observed.subjects ?? {})) {
    const before = new Set(signalsFor(committed.subjects?.[server]).map(identity));
    const signals = signalsFor(subject).filter((signal) => !before.has(identity(signal)));
    if (signals.length > 0) found.push({ server, signals });
  }

  return found.sort((a, b) => a.server.localeCompare(b.server));
}
