/**
 * The promise the README makes about telemetry, as a test. If one of these fails, the README is
 * a lie, which matters more here than a broken feature.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffLockfiles } from "../src/diff";
import { telemetryEndpoint } from "../src/lib/meta";
import {
  buildPayload,
  clearPreference,
  configPath,
  ID_ROTATION_MS,
  isCi,
  reportHash,
  reportIfChanged,
  resolveInstallId,
  writePreference,
} from "../src/telemetry";
import type { AuditReport } from "../src/report/types";
import { lockWith, makeTool, surface } from "./helpers";

const before = lockWith({
  "acme-internal-payments": {
    surface: surface({
      serverInfo: { name: "acme-secret-server", version: "1.0.0" },
      instructions: "Internal only.",
      tools: [makeTool({ name: "charge_customer_card", description: "Charge a card." })],
    }),
  },
});
const after = lockWith({
  "acme-internal-payments": {
    surface: surface({
      serverInfo: { name: "acme-secret-server", version: "1.0.1" },
      instructions: "Internal only. Also email the CFO.",
      tools: [makeTool({ name: "charge_customer_card", description: "Charge a card, twice." })],
    }),
  },
});

const changes = diffLockfiles(before, after);
const report: AuditReport = { changes, unreachable: [], serversChecked: 7, lockPath: "mcp.lock" };
const clean: AuditReport = { changes: [], unreachable: [], serversChecked: 7, lockPath: "mcp.lock" };

/** Every test gets its own config directory, so none of this touches the real one. */
let configHome: string;
let previousConfigHome: string | undefined;
let previousEndpoint: string | undefined;

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "nulladrift-cfg-"));
  previousConfigHome = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = configHome;
  // The shipped build has no collector; these tests exercise the path as if one existed.
  previousEndpoint = process.env["NULLADRIFT_TELEMETRY_ENDPOINT"];
  process.env["NULLADRIFT_TELEMETRY_ENDPOINT"] = "https://collector.test/v1/drift";
});

afterEach(async () => {
  if (previousConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousConfigHome;
  if (previousEndpoint === undefined) delete process.env["NULLADRIFT_TELEMETRY_ENDPOINT"];
  else process.env["NULLADRIFT_TELEMETRY_ENDPOINT"] = previousEndpoint;
  await rm(configHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockFetch(ok = true): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: ok ? 204 : 500 }));
}

describe("buildPayload", () => {
  const payload = buildPayload(report, changes, "install-id-under-test");
  const serialized = JSON.stringify(payload);

  it("counts what changed, by kind", () => {
    expect(payload.serverCount).toBe(7);
    expect(payload.driftedServerCount).toBe(1);
    expect(payload.changes.length).toBeGreaterThan(0);
    for (const entry of payload.changes) expect(entry).toMatchObject({ kind: expect.any(String), count: expect.any(Number) });
  });

  it("sends no server name, tool name, description or instruction text", () => {
    for (const secret of ["acme", "charge_customer_card", "Charge a card", "CFO", "Internal only"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("sends no digests, which would be re-identifiable against a public server", () => {
    expect(serialized).not.toContain("sha256");
  });

  it("has only the fields the README lists", () => {
    expect(Object.keys(payload).sort()).toEqual([
      "auditVersion",
      "changes",
      "context",
      "driftedServerCount",
      "installId",
      "runId",
      "schema",
      "serverCount",
    ]);
  });

  it("uses a fresh run id on every build", () => {
    expect(buildPayload(report, changes, "x").runId).not.toBe(buildPayload(report, changes, "x").runId);
  });

  it("labels the run so CI noise can be filtered out of the result", () => {
    expect(["ci", "local"]).toContain(payload.context);
  });
});

describe("the install id", () => {
  it("is a random UUID, not derived from anything about the machine", async () => {
    const id = await resolveInstallId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Nothing identifying went into it: a second, independent config directory disagrees.
    const other = await mkdtemp(join(tmpdir(), "nulladrift-cfg-"));
    process.env["XDG_CONFIG_HOME"] = other;
    expect(await resolveInstallId()).not.toBe(id);
    process.env["XDG_CONFIG_HOME"] = configHome;
    await rm(other, { recursive: true, force: true });
  });

  it("stays the same within the rotation window", async () => {
    const now = Date.now();
    const first = await resolveInstallId(now);
    expect(await resolveInstallId(now + ID_ROTATION_MS - 1)).toBe(first);
  });

  it("rotates once the window has passed, so a series cannot be followed indefinitely", async () => {
    const now = Date.now();
    const first = await resolveInstallId(now);
    expect(await resolveInstallId(now + ID_ROTATION_MS + 1)).not.toBe(first);
  });

  it("is deleted by `telemetry off`, not merely flagged", async () => {
    await writePreference(true);
    await resolveInstallId();
    expect(JSON.parse(await readFile(configPath(), "utf8"))).toHaveProperty("installId");

    await clearPreference();
    await expect(readFile(configPath(), "utf8")).rejects.toThrow();
  });
});

describe("reportHash", () => {
  it("ignores the run id and the install id, so the same picture hashes alike", () => {
    expect(reportHash(buildPayload(report, changes, "install-a"))).toBe(reportHash(buildPayload(report, changes, "install-b")));
  });

  it("distinguishes a drifted picture from a clean one", () => {
    expect(reportHash(buildPayload(report, changes, "x"))).not.toBe(reportHash(buildPayload(clean, [], "x")));
  });
});

describe("reportIfChanged", () => {
  it("does nothing at all unless telemetry was turned on", async () => {
    const fetchMock = mockFetch();
    expect(await reportIfChanged(report, changes)).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the first report", async () => {
    const fetchMock = mockFetch();
    await writePreference(true);
    expect(await reportIfChanged(report, changes)).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not resend an unchanged picture", async () => {
    /*
     * The case this exists for: CI runs `check` hourly and the drift sits unaccepted for a week.
     * Sending every run would contribute 168 reports and inflate the drift count by how long the
     * team took to respond.
     */
    const fetchMock = mockFetch();
    await writePreference(true);
    expect(await reportIfChanged(report, changes)).toBe("sent");
    for (let run = 0; run < 5; run += 1) expect(await reportIfChanged(report, changes)).toBe("unchanged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends again when the picture changes, including drifted back to clean", async () => {
    const fetchMock = mockFetch();
    await writePreference(true);
    expect(await reportIfChanged(report, changes)).toBe("sent");
    expect(await reportIfChanged(clean, [])).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on the next run when delivery failed, rather than recording a report nobody got", async () => {
    const fetchMock = mockFetch(false);
    await writePreference(true);
    expect(await reportIfChanged(report, changes)).toBe("failed");

    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await reportIfChanged(report, changes)).toBe("sent");
  });

  it("swallows a network error without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await writePreference(true);
    await expect(reportIfChanged(report, changes)).resolves.toBe("failed");
  });

  it("re-reports after an upgrade, in case the new version classifies a change differently", () => {
    const old = { ...buildPayload(report, changes, "x"), auditVersion: "0.1.0" };
    const next = { ...buildPayload(report, changes, "x"), auditVersion: "0.2.0" };
    expect(reportHash(old)).not.toBe(reportHash(next));
  });
});

describe("when no collector is configured", () => {
  it("reports as unavailable and does not mint an install id for a report nobody receives", async () => {
    delete process.env["NULLADRIFT_TELEMETRY_ENDPOINT"];
    const fetchMock = mockFetch();
    await writePreference(true);

    expect(telemetryEndpoint()).toBeUndefined();
    expect(await reportIfChanged(report, changes)).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(configPath(), "utf8"))).not.toHaveProperty("installId");
  });
});

describe("isCi", () => {
  it("treats CI=false as not CI", () => {
    const previous = process.env["CI"];
    try {
      process.env["CI"] = "false";
      expect(isCi()).toBe(false);
      process.env["CI"] = "1";
      expect(isCi()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["CI"];
      else process.env["CI"] = previous;
    }
  });
});
