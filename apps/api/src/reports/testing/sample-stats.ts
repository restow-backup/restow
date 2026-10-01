import type {
  BackupCounts,
  RestoreCounts,
  TenantAggregate,
  ThrottleCounts,
  VolumeBytes,
} from "../../features/stats/aggregate.js";
import { buildStats } from "../../features/stats/build.js";
import type { CauseCount } from "../../features/stats/causes.js";
import type { LargestObjectDto, StatsDto, TenantRefDto } from "../../features/stats/dto.js";
import { resolvePeriod } from "../../features/stats/period.js";
import { type ReadinessCounts, countedTotal } from "../../features/stats/readiness.js";

/**
 * Statistics for the report tests, built the way the API builds them: fixed
 * per-tenant figures go through buildStats, so every key figure, dataset and
 * "not available" notice is one the API could really send (a tenant without
 * Microsoft 365 has neither a throttling series nor a throttling figure).
 *
 *   - Fabrikam AG: IMAP only, 205 accounts growing to 212, each backed up
 *     every day; the tenant report;
 *   - Contoso GmbH: Microsoft 365, 146 mailboxes and OneDrives growing to 150;
 *   - Adatum KG: added at the end of the period, no backup completed yet.
 * The provider report covers all three.
 */

const GIB = 1024 ** 3;
const NOW = new Date("2026-09-23T10:00:00.000Z");
const PERIOD = resolvePeriod({ from: "2026-08-25", to: "2026-09-23" }, NOW);
const BUCKETS = PERIOD.buckets.length;

function perBucket<T>(make: (index: number) => T): T[] {
  return Array.from({ length: BUCKETS }, (_, index) => make(index));
}

function sum<T extends object>(rows: readonly T[], keys: readonly (keyof T)[]): T {
  const total = Object.fromEntries(keys.map((key) => [key, 0])) as Record<keyof T, number>;
  for (const row of rows) {
    for (const key of keys) {
      total[key] += row[key] as number;
    }
  }
  return total as T;
}

/** The worst state, as the readiness overview rates a tenant. */
function overall(counts: ReadinessCounts): TenantAggregate["overallEnd"] {
  if (countedTotal(counts) === 0) {
    return null;
  }
  if (counts.red > 0 || counts.unverified > 0) {
    return "red";
  }
  return counts.yellow > 0 ? "yellow" : "green";
}

interface SampleTenant {
  readonly tenant: TenantRefDto;
  readonly microsoft365: boolean;
  /** A backup completed by the end of the period. */
  readonly hasBackups: boolean;
  readonly backups: BackupCounts[];
  readonly previousBackups: BackupCounts;
  readonly restores: RestoreCounts[];
  readonly previousRestores: RestoreCounts;
  /** Graph throttling per bucket; all zero without Microsoft 365. */
  readonly throttling: ThrottleCounts[];
  readonly previousThrottling: ThrottleCounts;
  readonly volume: VolumeBytes[];
  readonly physicalAtStart: number;
  readonly readiness: ReadinessCounts[];
  readonly readinessStart: ReadinessCounts;
  readonly logicalBytes: { start: number; end: number };
  readonly dedup: { start: number; end: number };
  readonly durations: Map<string, number[]>;
  readonly failedItems: { current: number; previous: number };
  readonly causes: CauseCount[];
  readonly largest: Omit<LargestObjectDto, "tenant">[];
}

function aggregate(sample: SampleTenant, provider: boolean): TenantAggregate {
  let stored = sample.physicalAtStart;
  const storage = sample.volume.map((bytes) => {
    stored += bytes.physicalBytes;
    return stored;
  });
  const readinessEnd = sample.readiness.at(-1) as ReadinessCounts;
  const physicalEnd = stored;
  return {
    tenant: sample.tenant,
    available: {
      objects: true,
      backups: sample.hasBackups,
      microsoft365: sample.microsoft365,
    },
    backups: sample.backups,
    backupTotals: {
      current: sum(sample.backups, ["succeeded", "failed", "cancelled"]),
      previous: sample.previousBackups,
    },
    restores: sample.restores,
    restoreTotals: {
      current: sum(sample.restores, ["completed", "failed"]),
      previous: sample.previousRestores,
    },
    throttling: sample.throttling,
    throttlingTotals: {
      current: sum(sample.throttling, ["waitMs", "events"]),
      previous: sample.previousThrottling,
    },
    volume: sample.volume,
    storage,
    readiness: sample.readiness,
    readinessStart: sample.readinessStart,
    readinessEnd,
    overallEnd: overall(readinessEnd),
    durations: sample.durations,
    levels: {
      start: {
        protectedObjects: countedTotal(sample.readinessStart),
        logicalBytes: sample.logicalBytes.start,
        retainedBytes: Math.round(sample.dedup.start * sample.physicalAtStart),
        physicalBytes: sample.physicalAtStart,
      },
      end: {
        protectedObjects: countedTotal(readinessEnd),
        logicalBytes: sample.logicalBytes.end,
        retainedBytes: Math.round(sample.dedup.end * physicalEnd),
        physicalBytes: physicalEnd,
      },
    },
    failedItems: sample.failedItems,
    causes: sample.causes,
    largest: sample.largest.map((object) =>
      provider ? { ...object, tenant: sample.tenant } : object,
    ),
  };
}

/** Durations of `count` runs, spread evenly between `from` and `to` seconds. */
function runTimes(count: number, from: number, to: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index * ((to - from) / count));
}

const NO_THROTTLING = { waitMs: 0, events: 0 };

function fabrikam(): SampleTenant {
  const backups = perBucket((index) => ({
    succeeded: index % 3 === 0 ? 196 : 197,
    failed: index % 3 === 0 ? 4 : 3,
    cancelled: index % 13 === 0 ? 1 : 0,
  }));
  const restores = perBucket((index) => ({
    completed: index % 3 === 0 ? 1 : 0,
    failed: index === 12 ? 1 : 0,
  }));
  return {
    tenant: { id: "7a1d9e02-5c3b-4f8e-b2a4-6e9d0c3f5b12", name: "Fabrikam AG" },
    microsoft365: false,
    hasBackups: true,
    // 5,900 succeeded and 100 failed runs: 98.3%, after 95% in the previous period.
    backups,
    previousBackups: { succeeded: 5700, failed: 300, cancelled: 2 },
    restores,
    previousRestores: { completed: 8, failed: 1 },
    throttling: perBucket(() => ({ ...NO_THROTTLING })),
    previousThrottling: NO_THROTTLING,
    volume: perBucket((index) => ({
      logicalBytes: (55 + (index % 5)) * GIB,
      physicalBytes: (1 + (index % 3)) * GIB,
    })),
    physicalAtStart: 610 * GIB,
    readiness: perBucket((index) => {
      const total = 205 + Math.floor(((index + 1) * 7) / BUCKETS);
      const red = index > 20 ? 1 : 2;
      const unverified = 18 - Math.floor(index / 3);
      return { green: total - 12 - red - unverified, yellow: 12, red, unverified };
    }),
    readinessStart: { green: 172, yellow: 12, red: 2, unverified: 19 },
    logicalBytes: { start: 1741 * GIB, end: 1843 * GIB },
    dedup: { start: 6.1, end: 6.42 },
    durations: new Map([
      ["backup", runTimes(5900, 180, 420)],
      ["restore", runTimes(10, 75, 610)],
      ["verify", runTimes(30, 40, 130)],
    ]),
    failedItems: { current: 37, previous: 12 },
    causes: [
      {
        cause: "IMAP FETCH failed: Connection reset by peer",
        count: 21,
        lastAt: new Date("2026-09-22T02:14:00Z"),
      },
      {
        cause: "IMAP UID … vanished during FETCH",
        count: 9,
        lastAt: new Date("2026-09-20T01:40:00Z"),
      },
      {
        cause: "MIME structure could not be parsed",
        count: 7,
        lastAt: new Date("2026-09-18T03:02:00Z"),
      },
    ],
    largest: [
      {
        id: "0b9c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
        name: "Buchhaltung Müller & Söhne",
        kind: "imap",
        logicalBytes: 48 * GIB,
        lastBackupAt: "2026-09-23T02:00:00.000Z",
        state: "green",
      },
      {
        id: "1b9c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
        name: "Łukasz Kowalski",
        kind: "imap",
        logicalBytes: 31 * GIB,
        lastBackupAt: "2026-09-23T02:30:00.000Z",
        state: "unverified",
      },
      {
        id: "2b9c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
        name: "Empfang",
        kind: "imap",
        logicalBytes: 12 * GIB,
        lastBackupAt: "2026-09-23T01:10:00.000Z",
        state: "yellow",
      },
    ],
  };
}

function contoso(): SampleTenant {
  return {
    tenant: { id: "3f0c2a4e-1b7d-4c55-9a61-0d2e8f1b7c01", name: "Contoso GmbH" },
    microsoft365: true,
    hasBackups: true,
    // 4,454 succeeded and 46 failed runs, after 4,200 and 300.
    backups: perBucket((index) => ({
      succeeded: index % 4 === 0 ? 147 : 149,
      failed: index % 4 === 0 ? 3 : 1,
      cancelled: 0,
    })),
    previousBackups: { succeeded: 4200, failed: 300, cancelled: 0 },
    restores: perBucket((index) => ({ completed: index % 5 === 0 ? 1 : 0, failed: 0 })),
    previousRestores: { completed: 4, failed: 0 },
    // 5,400 s of waiting in the period (1.5 hours), 7,200 s in the one before.
    throttling: perBucket((index) =>
      index % 5 === 0 ? { waitMs: 900_000, events: 3 + (index % 4) } : { ...NO_THROTTLING },
    ),
    previousThrottling: { waitMs: 7_200_000, events: 21 },
    volume: perBucket((index) => ({
      logicalBytes: (38 + (index % 4)) * GIB,
      physicalBytes: (1 + (index % 2)) * GIB,
    })),
    physicalAtStart: 400 * GIB,
    readiness: perBucket((index) => {
      // Every backup proven by the end; one was not restorable for a while.
      const total = 146 + Math.floor(((index + 1) * 4) / BUCKETS);
      const red = index > 15 && index < 25 ? 1 : 0;
      const unverified = Math.max(0, 7 - Math.floor(index / 4));
      return { green: total - 6 - red - unverified, yellow: 6, red, unverified };
    }),
    readinessStart: { green: 131, yellow: 6, red: 0, unverified: 9 },
    logicalBytes: { start: 1180 * GIB, end: 1230 * GIB },
    dedup: { start: 3.1, end: 3.2 },
    durations: new Map([
      ["backup", runTimes(4454, 300, 2400)],
      ["restore", runTimes(6, 90, 900)],
      ["verify", runTimes(30, 60, 240)],
    ]),
    failedItems: { current: 19, previous: 8 },
    causes: [
      { cause: "Graph 404 ErrorItemNotFound", count: 14, lastAt: new Date("2026-09-21T03:10:00Z") },
      {
        cause: "Graph 413 ErrorMessageSizeExceeded",
        count: 5,
        lastAt: new Date("2026-09-19T02:05:00Z"),
      },
    ],
    largest: [
      {
        id: "4d2e8f30-ab1c-4d9e-9f80-7b6c5d4e3f21",
        name: "Geschäftsführung",
        kind: "mailbox",
        logicalBytes: 64 * GIB,
        lastBackupAt: "2026-09-23T01:45:00.000Z",
        state: "green",
      },
      {
        id: "5e3f9041-bc2d-4eaf-a091-8c7d6e5f4032",
        name: "Marketing",
        kind: "onedrive",
        logicalBytes: 40 * GIB,
        lastBackupAt: "2026-09-23T03:20:00.000Z",
        state: "yellow",
      },
    ],
  };
}

function adatum(): SampleTenant {
  const zeroRuns = { succeeded: 0, failed: 0, cancelled: 0 };
  const none = { green: 0, yellow: 0, red: 0, unverified: 0 };
  return {
    tenant: { id: "9b2c4d6e-8f01-4a23-b456-c789d0e1f234", name: "Adatum KG" },
    microsoft365: false,
    hasBackups: false,
    backups: perBucket(() => ({ ...zeroRuns })),
    previousBackups: zeroRuns,
    restores: perBucket(() => ({ completed: 0, failed: 0 })),
    previousRestores: { completed: 0, failed: 0 },
    throttling: perBucket(() => ({ ...NO_THROTTLING })),
    previousThrottling: NO_THROTTLING,
    volume: perBucket(() => ({ logicalBytes: 0, physicalBytes: 0 })),
    physicalAtStart: 0,
    // Three accounts added on 2026-09-21, none backed up yet: not proven.
    readiness: perBucket((index) => (index >= 27 ? { ...none, unverified: 3 } : { ...none })),
    readinessStart: none,
    logicalBytes: { start: 0, end: 0 },
    dedup: { start: 0, end: 0 },
    durations: new Map(),
    failedItems: { current: 0, previous: 0 },
    causes: [],
    largest: [],
  };
}

/** The report tests' statistics: Fabrikam alone, or every tenant for the provider. */
export function sampleStats(scope: "tenant" | "provider" = "tenant"): StatsDto {
  const provider = scope === "provider";
  const tenants = provider ? [contoso(), fabrikam(), adatum()] : [fabrikam()];
  return buildStats({
    period: PERIOD,
    scope,
    tenants: tenants.map((tenant) => aggregate(tenant, provider)),
    generatedAt: NOW,
  });
}
