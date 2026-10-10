import { describe, expect, it } from "vitest";
import { aggregateTenant, mergeTotals } from "./aggregate.js";
import { buildStats } from "./build.js";
import { type EndpointFacts, NO_ENDPOINT_FACTS } from "./endpoint-facts.js";
import type {
  ReadinessObject,
  ReadinessReport,
  ReadinessSnapshot,
  StoredLevels,
  TenantFacts,
} from "./facts.js";
import { resolvePeriod } from "./period.js";

const NOW = new Date("2026-09-23T10:00:00.000Z");
// Current period 2026-09-21..23 (3 days), previous 2026-09-18..20.
const period = resolvePeriod({ from: "2026-09-21", to: "2026-09-23" }, NOW);

const at = (date: string, hour = 12) =>
  new Date(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`);

const levels = (): StoredLevels => ({ logicalBytes: 0, retainedBytes: 0, physicalBytes: 0 });

function facts(overrides: Partial<TenantFacts> = {}): TenantFacts {
  return {
    tenant: { id: "t-1", name: "Contoso" },
    protectedObjectCount: 0,
    hasMicrosoft365: false,
    hasBackups: false,
    backupRuns: [],
    restoreRuns: [],
    throttling: [],
    snapshotBytes: [],
    packBytes: [],
    durations: [],
    levels: { start: levels(), end: levels() },
    failedItems: { current: 0, previous: 0 },
    failureReasons: [],
    objects: [],
    snapshots: [],
    reports: [],
    endpoints: NO_ENDPOINT_FACTS,
    largestSnapshots: [],
    ...overrides,
  };
}

function endpointFacts(overrides: Partial<EndpointFacts> = {}): EndpointFacts {
  return { ...NO_ENDPOINT_FACTS, ...overrides };
}

/** A mailbox protected since long before the period, with a backup that was never checked. */
const mailbox: ReadinessObject = {
  id: "mailbox",
  name: "Anna",
  kind: "mailbox",
  status: "active",
  createdAt: at("2026-09-01"),
};
const mailboxBackup: ReadinessSnapshot = {
  id: "mailbox-1",
  objectId: "mailbox",
  sequence: 1,
  completedAt: at("2026-09-10"),
  prunedAt: null,
};
const mailboxCheck: ReadinessReport = {
  id: "check-1",
  objectId: "mailbox",
  snapshotId: "mailbox-1",
  origin: "verify",
  readiness: "green",
  checkedAt: at("2026-09-11"),
  createdAt: at("2026-09-11"),
};

/** An endpoint protected since before the period, backed up on 09-20 and tested on 09-22. */
const server = { id: "server", createdAt: at("2026-09-01"), revokedAt: null };
const serverBackup = {
  endpointId: "server",
  snapshotId: "server-1",
  partial: false,
  finishedAt: at("2026-09-20"),
};
const serverTest = {
  endpointId: "server",
  kind: "restore_test" as const,
  origin: "server" as const,
  snapshotId: "server-1",
  readiness: "green" as const,
  checkedAt: at("2026-09-22", 18),
};

describe("aggregateTenant with endpoints", () => {
  it("counts a tenant that only has endpoints as having data, never as unavailable", () => {
    const none = aggregateTenant(facts(), period, "tenant");
    expect(none.available.objects).toBe(false);

    const only = aggregateTenant(
      facts({ endpoints: endpointFacts({ list: [server] }) }),
      period,
      "tenant",
    );
    expect(only.available.objects).toBe(true);
    // The data sources of the chunk store stay as they were.
    expect(only.available.backups).toBe(false);
    expect(only.available.microsoft365).toBe(false);

    const stats = buildStats({ period, scope: "tenant", tenants: [only], generatedAt: NOW });
    expect(stats.series.readiness).not.toHaveProperty("unavailable");
    expect(stats.series.backups).not.toHaveProperty("unavailable");
    expect(stats.kpis.verifiedShare.value).not.toBeNull();
    expect(stats.kpis.backupSuccessRate).toEqual({ value: null, previous: null });
    // Volume, storage and the largest objects have no endpoint figures.
    expect(stats.series.volume).toEqual({ unavailable: "no_backups_yet" });
    expect(stats.series.storage).toEqual({ unavailable: "no_backups_yet" });
    expect(stats.tables.largestObjects).toEqual({ unavailable: "no_backups_yet" });
  });

  it("counts a revoked endpoint as data, even when nothing else exists", () => {
    const revoked = { ...server, revokedAt: at("2026-09-05") };
    const only = aggregateTenant(
      facts({ endpoints: endpointFacts({ list: [revoked] }) }),
      period,
      "tenant",
    );
    expect(only.available.objects).toBe(true);
    // Revoked before the period: protected at none of its moments.
    expect(only.readinessEnd).toEqual({ green: 0, yellow: 0, red: 0, unverified: 0 });
    expect(only.levels.end.protectedObjects).toBe(0);
    expect(only.overallEnd).toBeNull();
  });

  it("rates endpoints in the readiness series, the levels and the overall rating", () => {
    const aggregate = aggregateTenant(
      facts({
        protectedObjectCount: 1,
        objects: [mailbox],
        snapshots: [mailboxBackup],
        reports: [mailboxCheck],
        endpoints: endpointFacts({
          list: [server],
          backups: [serverBackup],
          reports: [serverTest],
        }),
      }),
      period,
      "tenant",
    );
    // End of 09-21 and 09-22: the endpoint's backup of 09-20 is untested (unverified);
    // the test of 09-22 18:00 counts from the end of that day.
    expect(aggregate.readiness).toEqual([
      { green: 1, yellow: 0, red: 0, unverified: 1 },
      { green: 2, yellow: 0, red: 0, unverified: 0 },
      { green: 2, yellow: 0, red: 0, unverified: 0 },
    ]);
    expect(aggregate.readinessStart).toEqual({ green: 1, yellow: 0, red: 0, unverified: 1 });
    expect(aggregate.readinessEnd).toEqual({ green: 2, yellow: 0, red: 0, unverified: 0 });
    // Objects and endpoints are one protected total.
    expect(aggregate.levels.start.protectedObjects).toBe(2);
    expect(aggregate.levels.end.protectedObjects).toBe(2);
    // The mailbox was checked 09-11: more than 8 days old at the end, so it needs attention.
    expect(aggregate.overallEnd).toBe("yellow");
  });

  it("makes an unproven endpoint the reason a tenant of proven objects is not ready", () => {
    const aggregate = aggregateTenant(
      facts({
        protectedObjectCount: 1,
        objects: [{ ...mailbox, createdAt: at("2026-09-15") }],
        snapshots: [{ ...mailboxBackup, completedAt: at("2026-09-16") }],
        reports: [{ ...mailboxCheck, checkedAt: at("2026-09-20"), createdAt: at("2026-09-20") }],
        endpoints: endpointFacts({ list: [server], backups: [serverBackup] }),
      }),
      period,
      "tenant",
    );
    expect(aggregate.readinessEnd).toEqual({ green: 1, yellow: 0, red: 0, unverified: 1 });
    expect(aggregate.overallEnd).toBe("red");
  });

  it("sums the protected objects of a tenant with mailboxes and endpoints", () => {
    const aggregate = aggregateTenant(
      facts({
        protectedObjectCount: 1,
        objects: [mailbox],
        endpoints: endpointFacts({
          list: [server, { id: "laptop", createdAt: at("2026-09-22"), revokedAt: null }],
        }),
      }),
      period,
      "tenant",
    );
    // At the start: the mailbox and the server. The laptop joins on 09-22.
    expect(aggregate.levels.start.protectedObjects).toBe(2);
    expect(aggregate.levels.end.protectedObjects).toBe(3);
    expect(aggregate.readinessEnd).toEqual({ green: 0, yellow: 0, red: 0, unverified: 3 });
  });

  it("adds endpoint backup runs to the job based ones, in the same buckets and totals", () => {
    const aggregate = aggregateTenant(
      facts({
        protectedObjectCount: 1,
        hasBackups: true,
        backupRuns: [
          { day: "2026-09-19", status: "completed", count: 1 },
          { day: "2026-09-21", status: "completed", count: 2 },
          { day: "2026-09-22", status: "cancelled", count: 1 },
        ],
        endpoints: endpointFacts({
          list: [server],
          backupRuns: [
            { day: "2026-09-19", status: "failed", count: 1 },
            { day: "2026-09-21", status: "succeeded", count: 1 },
            { day: "2026-09-22", status: "failed", count: 2 },
            { day: "2026-09-23", status: "succeeded", count: 3 },
            // Outside both periods.
            { day: "2026-09-01", status: "failed", count: 9 },
          ],
        }),
      }),
      period,
      "tenant",
    );
    expect(aggregate.backups).toEqual([
      { succeeded: 3, failed: 0, cancelled: 0 },
      { succeeded: 0, failed: 2, cancelled: 1 },
      { succeeded: 3, failed: 0, cancelled: 0 },
    ]);
    expect(aggregate.backupTotals.current).toEqual({ succeeded: 6, failed: 2, cancelled: 1 });
    expect(aggregate.backupTotals.previous).toEqual({ succeeded: 1, failed: 1, cancelled: 0 });

    const stats = buildStats({ period, scope: "tenant", tenants: [aggregate], generatedAt: NOW });
    // 6 of 8 current runs, 1 of 2 in the previous period.
    expect(stats.kpis.backupSuccessRate).toEqual({ value: 0.75, previous: 0.5 });
  });

  it("leaves every figure of a tenant without endpoints exactly as it was", () => {
    const base = facts({
      protectedObjectCount: 1,
      hasBackups: true,
      backupRuns: [{ day: "2026-09-22", status: "completed", count: 1 }],
      objects: [mailbox],
      snapshots: [mailboxBackup],
      reports: [mailboxCheck],
    });
    const aggregate = aggregateTenant(base, period, "tenant");
    expect(aggregate.backups[1]).toEqual({ succeeded: 1, failed: 0, cancelled: 0 });
    expect(aggregate.levels.end.protectedObjects).toBe(1);
    expect(aggregate.readinessEnd).toEqual({ green: 1, yellow: 0, red: 0, unverified: 0 });
    expect(aggregate.overallEnd).toBe("yellow");
  });

  it("keeps endpoints out of the largest objects and the storage figures", () => {
    const aggregate = aggregateTenant(
      facts({
        protectedObjectCount: 1,
        hasBackups: true,
        objects: [mailbox],
        snapshots: [mailboxBackup],
        largestSnapshots: [{ objectId: "mailbox", bytes: 500, completedAt: at("2026-09-10") }],
        endpoints: endpointFacts({
          list: [server],
          backups: [serverBackup],
          reports: [serverTest],
        }),
      }),
      period,
      "tenant",
    );
    expect(aggregate.largest.map((row) => row.id)).toEqual(["mailbox"]);
    expect(aggregate.volume.every((bucket) => bucket.logicalBytes === 0)).toBe(true);
    expect(aggregate.storage).toEqual([0, 0, 0]);
  });
});

describe("the provider scope with endpoints", () => {
  it("adds the endpoint figures of every tenant and the tenant rows count them", () => {
    const endpointsOnly = aggregateTenant(
      facts({
        tenant: { id: "t-2", name: "Fabrikam" },
        endpoints: endpointFacts({
          list: [server],
          backups: [serverBackup],
          reports: [serverTest],
        }),
      }),
      period,
      "provider",
    );
    const mixed = aggregateTenant(
      facts({
        tenant: { id: "t-3", name: "Adatum" },
        protectedObjectCount: 1,
        objects: [mailbox],
        snapshots: [mailboxBackup],
        reports: [mailboxCheck],
        endpoints: endpointFacts({ list: [server] }),
      }),
      period,
      "provider",
    );
    const empty = aggregateTenant(
      facts({ tenant: { id: "t-4", name: "Northwind" } }),
      period,
      "provider",
    );

    const merged = mergeTotals([endpointsOnly, mixed, empty], period.buckets.length);
    // Available for the provider as soon as one tenant has endpoints.
    expect(merged.available.objects).toBe(true);
    expect(merged.readinessEnd).toEqual({ green: 2, yellow: 0, red: 0, unverified: 1 });
    expect(merged.levels.end.protectedObjects).toBe(3);

    const stats = buildStats({
      period,
      scope: "provider",
      tenants: [endpointsOnly, mixed, empty],
      generatedAt: NOW,
    });
    expect(stats.kpis.protectedObjects).toEqual({ value: 3, previous: 3 });
    expect(stats.tables.tenants).toEqual([
      expect.objectContaining({ name: "Adatum", objects: 2, readiness: "red" }),
      expect.objectContaining({ name: "Fabrikam", objects: 1, readiness: "green" }),
      expect.objectContaining({ name: "Northwind", objects: 0, readiness: null }),
    ]);
  });
});

describe("aggregateTenant with VMs and containers of Proxmox VE", () => {
  const vm = { id: "vm-101", createdAt: at("2026-09-01"), inJob: true };
  const fresh = { id: "ct-200", createdAt: at("2026-09-01"), inJob: true };
  const left = { id: "vm-300", createdAt: at("2026-09-01"), inJob: false };
  const ignored = { id: "vm-400", createdAt: at("2026-09-01"), inJob: false };

  it("rates guests by the restore check of their newest restore point and counts their runs", () => {
    const aggregate = aggregateTenant(
      facts({
        guests: {
          list: [vm, fresh, left, ignored],
          restorePoints: [
            // Checked green on 09-21 at 18:00, before the end of the period.
            {
              guestId: "vm-101",
              sequence: 1,
              backupAt: at("2026-09-20"),
              prunedAt: null,
              check: { at: at("2026-09-21", 18), readiness: "green" },
            },
            // Left every job, but its restore point failed its check.
            {
              guestId: "vm-300",
              sequence: 1,
              backupAt: at("2026-09-10"),
              prunedAt: null,
              check: { at: at("2026-09-11"), readiness: "red" },
            },
          ],
          backupRuns: [
            { day: "2026-09-21", status: "succeeded", count: 2 },
            { day: "2026-09-22", status: "failed", count: 1 },
            { day: "2026-09-19", status: "succeeded", count: 1 },
          ],
        },
      }),
      period,
      "tenant",
    );
    // vm-101 green, ct-200 without a backup (unverified), vm-300 red; vm-400 never in a job.
    expect(aggregate.readinessEnd).toEqual({ green: 1, yellow: 0, red: 1, unverified: 1 });
    expect(aggregate.levels.end.protectedObjects).toBe(3);
    expect(aggregate.overallEnd).toBe("red");
    expect(aggregate.available.objects).toBe(true);
    expect(aggregate.backupTotals.current).toEqual({ succeeded: 2, failed: 1, cancelled: 0 });
    expect(aggregate.backupTotals.previous).toEqual({ succeeded: 1, failed: 0, cancelled: 0 });
    // At the start of the period vm-101's restore point was not checked yet.
    expect(aggregate.readinessStart).toEqual({ green: 0, yellow: 0, red: 1, unverified: 2 });
  });
});

describe("file shares in the statistics", () => {
  const office = { id: "office", createdAt: at("2026-09-01"), inJob: true };
  const scans = { id: "scans", createdAt: at("2026-09-01"), inJob: true };
  const old = { id: "old", createdAt: at("2026-09-01"), inJob: false };
  const idle = { id: "idle", createdAt: at("2026-09-01"), inJob: false };

  it("rates shares by their newest check, and counts their backups, restores and volume", () => {
    const aggregate = aggregateTenant(
      facts({
        fileShares: {
          list: [office, scans, old, idle],
          restorePoints: [
            // An older point checked red, a newer one checked yellow on 09-22: yellow decides.
            {
              shareId: "office",
              sequence: 1,
              at: at("2026-09-15"),
              prunedAt: null,
              checks: [{ at: at("2026-09-16"), readiness: "red" }],
            },
            {
              shareId: "office",
              sequence: 2,
              at: at("2026-09-21"),
              prunedAt: null,
              checks: [{ at: at("2026-09-22"), readiness: "yellow" }],
            },
            // Out of every job, its restore point still kept and checked green.
            {
              shareId: "old",
              sequence: 4,
              at: at("2026-09-05"),
              prunedAt: null,
              checks: [{ at: at("2026-09-06"), readiness: "green" }],
            },
          ],
          backupRuns: [
            { day: "2026-09-21", status: "succeeded", count: 3 },
            { day: "2026-09-22", status: "failed", count: 1 },
            { day: "2026-09-23", status: "cancelled", count: 1 },
            { day: "2026-09-18", status: "failed", count: 2 },
          ],
          restoreRuns: [
            { day: "2026-09-22", status: "completed", count: 2 },
            { day: "2026-09-19", status: "failed", count: 1 },
          ],
          volume: [{ day: "2026-09-21", bytes: 5000, bytesAdded: 300 }],
        },
      }),
      period,
      "tenant",
    );
    // office yellow, scans without a backup (unverified), old green; idle in no job, no point.
    expect(aggregate.readinessEnd).toEqual({ green: 1, yellow: 1, red: 0, unverified: 1 });
    expect(aggregate.levels.end.protectedObjects).toBe(3);
    // A share out of every job keeps the tenant from green, a share without a backup makes it red.
    expect(aggregate.overallEnd).toBe("red");
    // At the start office's newest point was the red one.
    expect(aggregate.readinessStart).toEqual({ green: 1, yellow: 0, red: 1, unverified: 1 });
    expect(aggregate.available.objects).toBe(true);
    expect(aggregate.available.backups).toBe(true);
    expect(aggregate.backupTotals.current).toEqual({ succeeded: 3, failed: 1, cancelled: 1 });
    expect(aggregate.backupTotals.previous).toEqual({ succeeded: 0, failed: 2, cancelled: 0 });
    expect(aggregate.restoreTotals.current).toEqual({ completed: 2, failed: 0 });
    expect(aggregate.restoreTotals.previous).toEqual({ completed: 0, failed: 1 });
    expect(aggregate.volume[0]).toEqual({ logicalBytes: 5000, physicalBytes: 300 });
  });

  it("a tenant without shares adds nothing", () => {
    const aggregate = aggregateTenant(facts(), period, "tenant");
    expect(aggregate.available).toEqual({ objects: false, backups: false, microsoft365: false });
    expect(aggregate.readinessEnd).toEqual({ green: 0, yellow: 0, red: 0, unverified: 0 });
  });
});
