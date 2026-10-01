import { type CauseCount, groupByCause } from "./causes.js";
import type { LargestObjectDto, StatsScopeName, TenantRefDto } from "./dto.js";
import { EndpointTimeline } from "./endpoint-timeline.js";
import type { Levels, ReadinessRating, StoredLevels, TenantFacts } from "./facts.js";
import { type ResolvedPeriod, bucketIndexByDay } from "./period.js";
import {
  type ReadinessCounts,
  ReadinessTimeline,
  emptyReadinessCounts,
  mergeReadiness,
} from "./readiness.js";

/**
 * From one tenant's facts to figures per bucket and per period (pure), and
 * the sum of several tenants for the provider scope. Every figure here adds
 * up across tenants; rates and ratios are derived from the sums afterwards
 * (build.ts), never averaged.
 */

/** Objects listed as the largest. */
export const MAX_LARGEST_OBJECTS = 10;

export interface BackupCounts {
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface RestoreCounts {
  completed: number;
  failed: number;
}

export interface ThrottleCounts {
  waitMs: number;
  events: number;
}

export interface VolumeBytes {
  logicalBytes: number;
  physicalBytes: number;
}

/** Which data sources exist (for at least one tenant, once merged). */
export interface Availability {
  objects: boolean;
  backups: boolean;
  microsoft365: boolean;
}

/** Figures that add up across tenants. Arrays are aligned with the period's buckets. */
export interface Totals {
  available: Availability;
  backups: BackupCounts[];
  backupTotals: { current: BackupCounts; previous: BackupCounts };
  restores: RestoreCounts[];
  restoreTotals: { current: RestoreCounts; previous: RestoreCounts };
  throttling: ThrottleCounts[];
  throttlingTotals: { current: ThrottleCounts; previous: ThrottleCounts };
  volume: VolumeBytes[];
  /** Physical bytes stored at the end of each bucket. */
  storage: number[];
  /** Readiness at the end of each bucket. */
  readiness: ReadinessCounts[];
  readinessStart: ReadinessCounts;
  readinessEnd: ReadinessCounts;
  /** Run times in seconds per job queue. */
  durations: Map<string, number[]>;
  levels: { start: Levels; end: Levels };
  failedItems: { current: number; previous: number };
  causes: CauseCount[];
  largest: LargestObjectDto[];
}

export interface TenantAggregate extends Totals {
  tenant: TenantRefDto;
  /** Overall readiness at the end of the period (the tenant row of the provider table). */
  overallEnd: ReadinessRating | null;
}

const emptyBackups = (): BackupCounts => ({ succeeded: 0, failed: 0, cancelled: 0 });
const emptyRestores = (): RestoreCounts => ({ completed: 0, failed: 0 });
const emptyThrottle = (): ThrottleCounts => ({ waitMs: 0, events: 0 });
const emptyVolume = (): VolumeBytes => ({ logicalBytes: 0, physicalBytes: 0 });
const emptyLevels = (): Levels => ({
  protectedObjects: 0,
  logicalBytes: 0,
  retainedBytes: 0,
  physicalBytes: 0,
});

function filled<T>(length: number, make: () => T): T[] {
  return Array.from({ length }, make);
}

/** Where a day falls: a bucket of the current period, the previous period, or neither. */
function locate(
  period: ResolvedPeriod,
  dayIndex: ReadonlyMap<string, number>,
  day: string,
): { bucket: number } | "previous" | null {
  const bucket = dayIndex.get(day);
  if (bucket !== undefined) {
    return { bucket };
  }
  return day >= period.previous.from && day <= period.previous.to ? "previous" : null;
}

const BACKUP_FIELD = {
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Record<string, keyof BackupCounts>;

/** Bucket one tenant's facts along the period. */
export function aggregateTenant(
  facts: TenantFacts,
  period: ResolvedPeriod,
  scope: StatsScopeName,
): TenantAggregate {
  const size = period.buckets.length;
  const dayIndex = bucketIndexByDay(period);

  const backups = filled(size, emptyBackups);
  const backupTotals = { current: emptyBackups(), previous: emptyBackups() };
  const addBackupRuns = (day: string, field: keyof BackupCounts, count: number) => {
    const where = locate(period, dayIndex, day);
    if (where === "previous") {
      backupTotals.previous[field] += count;
    } else if (where) {
      (backups[where.bucket] as BackupCounts)[field] += count;
      backupTotals.current[field] += count;
    }
  };
  for (const row of facts.backupRuns) {
    addBackupRuns(row.day, BACKUP_FIELD[row.status], row.count);
  }
  // Endpoint backups finish in the same buckets as the job based ones; a run
  // that only says "interrupted" was already left out when it was read.
  for (const row of facts.endpoints.backupRuns) {
    addBackupRuns(row.day, row.status, row.count);
  }

  const restores = filled(size, emptyRestores);
  const restoreTotals = { current: emptyRestores(), previous: emptyRestores() };
  for (const row of facts.restoreRuns) {
    const where = locate(period, dayIndex, row.day);
    if (where === "previous") {
      restoreTotals.previous[row.status] += row.count;
    } else if (where) {
      (restores[where.bucket] as RestoreCounts)[row.status] += row.count;
      restoreTotals.current[row.status] += row.count;
    }
  }

  const throttling = filled(size, emptyThrottle);
  const throttlingTotals = { current: emptyThrottle(), previous: emptyThrottle() };
  for (const row of facts.throttling) {
    const where = locate(period, dayIndex, row.day);
    const targets =
      where === "previous"
        ? [throttlingTotals.previous]
        : where
          ? [throttling[where.bucket] as ThrottleCounts, throttlingTotals.current]
          : [];
    for (const target of targets) {
      target.waitMs += row.waitMs;
      target.events += row.waits;
    }
  }

  const volume = filled(size, emptyVolume);
  for (const row of facts.snapshotBytes) {
    const bucket = dayIndex.get(row.day);
    if (bucket !== undefined) {
      (volume[bucket] as VolumeBytes).logicalBytes += row.bytes;
    }
  }
  const packsAdded = filled(size, () => 0);
  for (const row of facts.packBytes) {
    const bucket = dayIndex.get(row.day);
    if (bucket !== undefined) {
      (volume[bucket] as VolumeBytes).physicalBytes += row.bytes;
      packsAdded[bucket] = (packsAdded[bucket] ?? 0) + row.bytes;
    }
  }
  let stored = facts.levels.start.physicalBytes;
  const storage = packsAdded.map((added) => {
    stored += added;
    return stored;
  });

  const timeline = new ReadinessTimeline(facts.objects, facts.snapshots, facts.reports);
  const endpointTimeline = new EndpointTimeline(
    facts.endpoints.list,
    facts.endpoints.backups,
    facts.endpoints.reports,
  );
  // Protected objects and protected endpoints are rated side by side and counted as one.
  const readinessAt = (moment: Date) =>
    mergeReadiness(timeline.at(moment), endpointTimeline.at(moment));
  const readiness = period.buckets.map((bucket) => readinessAt(bucket.end).counts);
  const atStart = readinessAt(period.current.start);
  const atEnd = readinessAt(period.current.end);
  // The things readiness counts are the protected ones, so the two never disagree.
  const levelAt = (stored: StoredLevels, protectedObjects: number): Levels => ({
    ...stored,
    protectedObjects,
  });

  const durations = new Map<string, number[]>();
  for (const row of facts.durations) {
    const list = durations.get(row.queue);
    if (list) {
      list.push(row.seconds);
    } else {
      durations.set(row.queue, [row.seconds]);
    }
  }

  const objectsById = new Map(facts.objects.map((object) => [object.id, object]));
  const largest: LargestObjectDto[] = [];
  for (const snapshot of facts.largestSnapshots) {
    const object = objectsById.get(snapshot.objectId);
    // collect.ts lists the newest backups of protected objects only; every
    // such object existed at the end of the period and so has a state there.
    const state = atEnd.states.get(snapshot.objectId);
    if (!object || !state) {
      continue;
    }
    largest.push({
      id: object.id,
      name: object.name,
      kind: object.kind,
      logicalBytes: snapshot.bytes,
      lastBackupAt: snapshot.completedAt.toISOString(),
      state,
      ...(scope === "provider" ? { tenant: facts.tenant } : {}),
    });
  }

  return {
    tenant: facts.tenant,
    available: {
      // Endpoints are data sources of their own: a tenant that only backs up
      // servers and clients has readiness and backup outcomes to report too.
      objects: facts.protectedObjectCount > 0 || facts.endpoints.list.length > 0,
      backups: facts.hasBackups,
      microsoft365: facts.hasMicrosoft365,
    },
    backups,
    backupTotals,
    restores,
    restoreTotals,
    throttling,
    throttlingTotals,
    volume,
    storage,
    readiness,
    readinessStart: atStart.counts,
    readinessEnd: atEnd.counts,
    overallEnd: atEnd.overall,
    durations,
    levels: {
      start: levelAt(facts.levels.start, atStart.total),
      end: levelAt(facts.levels.end, atEnd.total),
    },
    failedItems: { ...facts.failedItems },
    causes: groupByCause(facts.failureReasons),
    largest: sortLargest(largest).slice(0, MAX_LARGEST_OBJECTS),
  };
}

function sortLargest(objects: readonly LargestObjectDto[]): LargestObjectDto[] {
  return [...objects].sort(
    (a, b) => b.logicalBytes - a.logicalBytes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Add every numeric field of `source` to the same field of `target`. */
function addInto<T extends object>(target: T, source: T): void {
  const into = target as unknown as Record<string, number>;
  const from = source as unknown as Record<string, number>;
  for (const key of Object.keys(from)) {
    into[key] = (into[key] ?? 0) + (from[key] ?? 0);
  }
}

function sumAligned<T extends object>(lists: readonly (readonly T[])[], make: () => T): T[] {
  const length = lists[0]?.length ?? 0;
  const result = filled(length, make);
  for (const list of lists) {
    list.forEach((entry, index) => addInto(result[index] as T, entry));
  }
  return result;
}

function sumOf<T extends object>(entries: readonly T[], make: () => T): T {
  const result = make();
  for (const entry of entries) {
    addInto(result, entry);
  }
  return result;
}

/**
 * Add up several tenants (the provider scope). A data source counts as
 * available when at least one tenant has it; tenants without it contribute
 * real zeros (a tenant without Microsoft 365 was never throttled by Graph).
 */
export function mergeTotals(parts: readonly Totals[], bucketCount: number): Totals {
  const durations = new Map<string, number[]>();
  for (const part of parts) {
    for (const [queue, seconds] of part.durations) {
      durations.set(queue, [...(durations.get(queue) ?? []), ...seconds]);
    }
  }
  const causes = new Map<string, CauseCount>();
  for (const part of parts) {
    for (const cause of part.causes) {
      const known = causes.get(cause.cause);
      causes.set(
        cause.cause,
        known
          ? {
              cause: cause.cause,
              count: known.count + cause.count,
              lastAt: known.lastAt.getTime() > cause.lastAt.getTime() ? known.lastAt : cause.lastAt,
            }
          : cause,
      );
    }
  }
  const aligned = <T extends object>(pick: (part: Totals) => T[], make: () => T): T[] =>
    parts.length === 0 ? filled(bucketCount, make) : sumAligned(parts.map(pick), make);

  return {
    available: {
      objects: parts.some((part) => part.available.objects),
      backups: parts.some((part) => part.available.backups),
      microsoft365: parts.some((part) => part.available.microsoft365),
    },
    backups: aligned((part) => part.backups, emptyBackups),
    backupTotals: {
      current: sumOf(
        parts.map((part) => part.backupTotals.current),
        emptyBackups,
      ),
      previous: sumOf(
        parts.map((part) => part.backupTotals.previous),
        emptyBackups,
      ),
    },
    restores: aligned((part) => part.restores, emptyRestores),
    restoreTotals: {
      current: sumOf(
        parts.map((part) => part.restoreTotals.current),
        emptyRestores,
      ),
      previous: sumOf(
        parts.map((part) => part.restoreTotals.previous),
        emptyRestores,
      ),
    },
    throttling: aligned((part) => part.throttling, emptyThrottle),
    throttlingTotals: {
      current: sumOf(
        parts.map((part) => part.throttlingTotals.current),
        emptyThrottle,
      ),
      previous: sumOf(
        parts.map((part) => part.throttlingTotals.previous),
        emptyThrottle,
      ),
    },
    volume: aligned((part) => part.volume, emptyVolume),
    storage: filled(bucketCount, () => 0).map((_, index) =>
      parts.reduce((sum, part) => sum + (part.storage[index] ?? 0), 0),
    ),
    readiness: aligned((part) => part.readiness, emptyReadinessCounts),
    readinessStart: sumOf(
      parts.map((part) => part.readinessStart),
      emptyReadinessCounts,
    ),
    readinessEnd: sumOf(
      parts.map((part) => part.readinessEnd),
      emptyReadinessCounts,
    ),
    durations,
    levels: {
      start: sumOf(
        parts.map((part) => part.levels.start),
        emptyLevels,
      ),
      end: sumOf(
        parts.map((part) => part.levels.end),
        emptyLevels,
      ),
    },
    failedItems: sumOf(
      parts.map((part) => part.failedItems),
      () => ({ current: 0, previous: 0 }),
    ),
    causes: [...causes.values()],
    largest: sortLargest(parts.flatMap((part) => part.largest)).slice(0, MAX_LARGEST_OBJECTS),
  };
}
