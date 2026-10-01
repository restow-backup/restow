import { describe, expect, it } from "vitest";
import { aggregateTenant } from "./aggregate.js";
import { buildStats, jobDurations, percentile, ratio } from "./build.js";
import type { StatsDto } from "./dto.js";
import { NO_ENDPOINT_FACTS } from "./endpoint-facts.js";
import type { ReadinessObject, StoredLevels, TenantFacts } from "./facts.js";
import { resolvePeriod } from "./period.js";

const NOW = new Date("2026-09-23T10:00:00.000Z");
// Current period 2026-09-21..23 (3 days), previous 2026-09-18..20.
const period = resolvePeriod({ from: "2026-09-21", to: "2026-09-23" }, NOW);

const levels = (overrides: Partial<StoredLevels> = {}): StoredLevels => ({
  logicalBytes: 0,
  retainedBytes: 0,
  physicalBytes: 0,
  ...overrides,
});

/** An active protected object created on `created` (a UTC day). */
const protectedObject = (id: string, created: string): ReadinessObject => ({
  id,
  name: id,
  kind: "mailbox",
  status: "active",
  createdAt: new Date(`${created}T08:00:00.000Z`),
});

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

const build = (tenants: TenantFacts[], scope: "tenant" | "provider" = "tenant"): StatsDto =>
  buildStats({
    period,
    scope,
    tenants: tenants.map((entry) => aggregateTenant(entry, period, scope)),
    generatedAt: NOW,
  });

describe("percentile and durations", () => {
  it("interpolates like Postgres percentile_cont", () => {
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(95);
  });

  it("lists durations per job kind in a fixed order", () => {
    const durations = new Map([
      ["verify", [5]],
      ["backup", [60, 30, 90]],
      ["custom", [1]],
    ]);
    expect(jobDurations(durations)).toEqual([
      { kind: "backup", p50Seconds: 60, p95Seconds: 87, count: 3 },
      { kind: "verify", p50Seconds: 5, p95Seconds: 5, count: 1 },
      { kind: "custom", p50Seconds: 1, p95Seconds: 1, count: 1 },
    ]);
  });

  it("returns null instead of dividing by zero", () => {
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(2, 3)).toBe(0.6667);
  });
});

describe("buildStats", () => {
  it("marks every dataset of a tenant without any data source as unavailable, never zero", () => {
    const stats = build([facts()]);
    expect(stats.series).toEqual({
      backups: { unavailable: "no_protected_objects" },
      volume: { unavailable: "no_backups_yet" },
      storage: { unavailable: "no_backups_yet" },
      jobDurations: [],
      throttling: { unavailable: "no_microsoft_365_source" },
      restores: { unavailable: "no_backups_yet" },
      readiness: { unavailable: "no_protected_objects" },
    });
    expect(stats.tables).toEqual({
      failuresByCause: { unavailable: "no_protected_objects" },
      largestObjects: { unavailable: "no_backups_yet" },
    });
    expect(stats.kpis.protectedObjects).toEqual({ value: 0, previous: 0 });
    for (const name of [
      "backupSuccessRate",
      "logicalBytes",
      "physicalBytes",
      "dedupRatio",
      "restores",
      "verifiedShare",
      "throttlingWaitSeconds",
      "failedItems",
    ] as const) {
      expect(stats.kpis[name]).toEqual({ value: null, previous: null });
    }
  });

  it("buckets runs, compares with the previous period and derives rates from the sums", () => {
    const stats = build([
      facts({
        protectedObjectCount: 2,
        hasBackups: true,
        hasMicrosoft365: true,
        backupRuns: [
          { day: "2026-09-19", status: "completed", count: 1 },
          { day: "2026-09-21", status: "completed", count: 3 },
          { day: "2026-09-22", status: "failed", count: 1 },
          { day: "2026-09-23", status: "cancelled", count: 2 },
          // Outside both periods: ignored.
          { day: "2026-09-10", status: "failed", count: 9 },
        ],
        throttling: [
          { day: "2026-09-20", waitMs: 1500, waits: 1 },
          { day: "2026-09-22", waitMs: 32_000, waits: 2 },
        ],
        packBytes: [{ day: "2026-09-22", bytes: 400 }],
        snapshotBytes: [{ day: "2026-09-22", bytes: 1000 }],
        // One protected before the period, one more during it.
        objects: [protectedObject("o-1", "2026-09-01"), protectedObject("o-2", "2026-09-22")],
        levels: {
          start: levels({ physicalBytes: 600, retainedBytes: 1200 }),
          end: levels({ physicalBytes: 1000, retainedBytes: 3000 }),
        },
      }),
    ]);
    expect(stats.series.backups).toEqual([
      { t: "2026-09-21", succeeded: 3, failed: 0, cancelled: 0 },
      { t: "2026-09-22", succeeded: 0, failed: 1, cancelled: 0 },
      { t: "2026-09-23", succeeded: 0, failed: 0, cancelled: 2 },
    ]);
    // Cancelled runs are not part of the rate.
    expect(stats.kpis.backupSuccessRate).toEqual({ value: 0.75, previous: 1 });
    expect(stats.kpis.throttlingWaitSeconds).toEqual({ value: 32, previous: 1.5 });
    expect(stats.series.throttling).toEqual([
      { t: "2026-09-21", waitSeconds: 0, events: 0 },
      { t: "2026-09-22", waitSeconds: 32, events: 2 },
      { t: "2026-09-23", waitSeconds: 0, events: 0 },
    ]);
    expect(stats.series.storage).toEqual([
      { t: "2026-09-21", bytes: 600 },
      { t: "2026-09-22", bytes: 1000 },
      { t: "2026-09-23", bytes: 1000 },
    ]);
    expect(stats.series.volume).toEqual([
      { t: "2026-09-21", logicalBytes: 0, physicalBytes: 0 },
      { t: "2026-09-22", logicalBytes: 1000, physicalBytes: 400 },
      { t: "2026-09-23", logicalBytes: 0, physicalBytes: 0 },
    ]);
    expect(stats.kpis.dedupRatio).toEqual({ value: 3, previous: 2 });
    expect(stats.kpis.protectedObjects).toEqual({ value: 2, previous: 1 });
  });

  it("adds tenants up in the provider scope and lists each of them", () => {
    const contoso = facts({
      tenant: { id: "t-1", name: "Contoso" },
      protectedObjectCount: 1,
      hasBackups: true,
      backupRuns: [{ day: "2026-09-21", status: "completed", count: 1 }],
      failedItems: { current: 2, previous: 0 },
      objects: [protectedObject("c-1", "2026-09-01")],
      // Backed up before the period, and that backup checked in it.
      snapshots: [
        {
          id: "c-1-s1",
          objectId: "c-1",
          sequence: 1,
          completedAt: new Date("2026-09-20T12:00:00.000Z"),
          prunedAt: null,
        },
      ],
      reports: [
        {
          id: "c-1-r1",
          objectId: "c-1",
          snapshotId: "c-1-s1",
          origin: "verify",
          readiness: "green",
          checkedAt: new Date("2026-09-21T06:00:00.000Z"),
          createdAt: new Date("2026-09-21T06:00:00.000Z"),
        },
      ],
      levels: { start: levels(), end: levels({ logicalBytes: 50 }) },
    });
    const fabrikam = facts({
      tenant: { id: "t-2", name: "Fabrikam" },
      protectedObjectCount: 1,
      hasMicrosoft365: true,
      backupRuns: [{ day: "2026-09-21", status: "failed", count: 1 }],
      throttling: [{ day: "2026-09-21", waitMs: 4000, waits: 1 }],
      objects: [protectedObject("f-1", "2026-09-22")],
    });
    const stats = build([fabrikam, contoso], "provider");
    expect(stats.scope).toBe("provider");
    expect(stats.kpis.backupSuccessRate.value).toBe(0.5);
    expect(stats.kpis.protectedObjects).toEqual({ value: 2, previous: 1 });
    // Contoso's backup is proven, Fabrikam's object was never backed up.
    expect(stats.kpis.verifiedShare).toEqual({ value: 0.5, previous: 0 });
    expect(stats.series.readiness).toEqual([
      { t: "2026-09-21", green: 1, yellow: 0, red: 0, unverified: 0 },
      { t: "2026-09-22", green: 1, yellow: 0, red: 0, unverified: 1 },
      { t: "2026-09-23", green: 1, yellow: 0, red: 0, unverified: 1 },
    ]);
    expect(stats.kpis.failedItems).toEqual({ value: 2, previous: 0 });
    // Available as soon as one tenant has the source.
    expect(stats.kpis.throttlingWaitSeconds.value).toBe(4);
    expect(stats.tables.tenants).toEqual([
      {
        id: "t-1",
        name: "Contoso",
        objects: 1,
        successRate: 1,
        logicalBytes: 50,
        physicalBytes: 0,
        readiness: "green",
        failures: 2,
      },
      {
        id: "t-2",
        name: "Fabrikam",
        objects: 1,
        successRate: 0,
        logicalBytes: 0,
        physicalBytes: 0,
        readiness: "red",
        failures: 0,
      },
    ]);
  });

  it("says so when the provider manages no tenant yet", () => {
    const stats = build([], "provider");
    expect(stats.series.backups).toEqual({ unavailable: "no_tenants" });
    expect(stats.series.jobDurations).toEqual({ unavailable: "no_tenants" });
    expect(stats.tables.tenants).toEqual({ unavailable: "no_tenants" });
    expect(stats.kpis.protectedObjects).toEqual({ value: null, previous: null });
  });
});
