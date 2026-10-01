// Pure planning logic: which schedules are due, when they run next, and which
// jobs one schedule expands into. Free of I/O so it is unit-tested without a
// database or a queue (docs/TESTING.md, stage 1).

import { scrubModeForCadence } from "@restow/core";
import type { Schedule, ScheduleKind } from "@restow/db";
import { CronSyntaxError, isValidTimeZone, nextCronOccurrence, parseCron } from "./cron.js";
import {
  JOB_PRIORITY,
  type ScheduledPayload,
  type ScheduledQueue,
  singletonKeyFor,
} from "./queues.js";

/** The `schedules` columns the planner reads (a subset of the Drizzle row type). */
export type ScheduleRow = Pick<
  Schedule,
  | "id"
  | "tenantId"
  | "protectedObjectId"
  | "kind"
  | "intervalMinutes"
  | "cron"
  | "timezone"
  | "enabled"
  | "nextRunAt"
  | "lastRunAt"
>;

/** What the planner needs to know about a tenant's protected objects and sources. */
export interface TenantTargets {
  readonly protectedObjects: readonly {
    readonly id: string;
    readonly sourceId: string;
    readonly kind: "mailbox" | "onedrive" | "imap";
    readonly status: "active" | "excluded" | "orphaned";
  }[];
  readonly sources: readonly {
    readonly id: string;
    readonly kind: "m365" | "imap" | "import";
    readonly status: "pending" | "active" | "error" | "disabled";
  }[];
}

/** A job the scheduler intends to enqueue this tick. */
export interface PlannedJob {
  readonly queue: ScheduledQueue;
  readonly payload: ScheduledPayload;
  readonly singletonKey: string;
  readonly priority: number;
  /** For the `jobs` row; null for tenant-wide jobs. */
  readonly protectedObjectId: string | null;
}

const MINUTE_MS = 60_000;

/** True when an enabled schedule should run at `now` (never-run schedules are due immediately). */
export function isDue(schedule: ScheduleRow, now: Date): boolean {
  if (!schedule.enabled) {
    return false;
  }
  return schedule.nextRunAt === null || schedule.nextRunAt.getTime() <= now.getTime();
}

/**
 * The next run after `now`. Interval schedules anchor on the tick that ran
 * them (drift is harmless for backups); cron schedules follow the expression
 * in their zone. Throws on an invalid cron expression or time zone, which the
 * tick loop turns into a deferred retry instead of a hot loop.
 */
export function computeNextRunAt(schedule: ScheduleRow, now: Date): Date {
  if (schedule.intervalMinutes !== null) {
    if (schedule.intervalMinutes <= 0) {
      throw new Error(`schedule ${schedule.id}: interval must be positive`);
    }
    return new Date(now.getTime() + schedule.intervalMinutes * MINUTE_MS);
  }
  if (schedule.cron === null) {
    throw new Error(`schedule ${schedule.id}: neither interval nor cron is set`);
  }
  if (!isValidTimeZone(schedule.timezone)) {
    throw new Error(`schedule ${schedule.id}: unknown time zone "${schedule.timezone}"`);
  }
  const next = nextCronOccurrence(parseCron(schedule.cron), now, schedule.timezone);
  if (next === null) {
    throw new CronSyntaxError(`schedule ${schedule.id}: "${schedule.cron}" never matches`);
  }
  return next;
}

/**
 * A source that can be worked against: consented/connected, or failing but worth
 * retrying. The import source (mail files brought in by hand, docs/IMPORT.md) is
 * never worked against: nothing is backed up, verified or archived from it, and
 * its imported mailboxes are not scheduled either.
 */
function sourceUsable(source: TenantTargets["sources"][number]): boolean {
  return source.kind !== "import" && (source.status === "active" || source.status === "error");
}

/**
 * Rarely-run scrubs check everything; frequent ones sample (docs/TESTING.md).
 * The rule is shared with the API's recommended schedules (@restow/core).
 */
export function scrubModeFor(schedule: ScheduleRow): "sample" | "full" {
  return scrubModeForCadence(schedule);
}

function planned(
  queue: ScheduledQueue,
  payload: ScheduledPayload,
  protectedObjectId: string | null,
): PlannedJob {
  return {
    queue,
    payload,
    singletonKey: singletonKeyFor(queue, payload as never),
    priority: JOB_PRIORITY[queue],
    protectedObjectId,
  };
}

/**
 * Expand a due schedule into jobs. `protectedObjectId` narrows backup, verify
 * and archive schedules to one object; otherwise they cover every active
 * object (or, for archive/directory, every usable source) of the tenant.
 * Retention and scrub are tenant-wide by nature.
 */
export function expandSchedule(
  schedule: ScheduleRow,
  targets: TenantTargets,
  newJobId: () => string,
): PlannedJob[] {
  const base = { tenantId: schedule.tenantId, scheduleId: schedule.id };
  const usableSources = new Map(
    targets.sources.filter(sourceUsable).map((source) => [source.id, source]),
  );
  const objects = targets.protectedObjects.filter(
    (object) =>
      object.status === "active" &&
      usableSources.has(object.sourceId) &&
      (schedule.protectedObjectId === null || object.id === schedule.protectedObjectId),
  );

  switch (schedule.kind) {
    case "backup":
      return objects.map((object) =>
        planned("backup", { ...base, jobId: newJobId(), protectedObjectId: object.id }, object.id),
      );
    case "verify":
      return objects.map((object) =>
        planned(
          "verify",
          { ...base, jobId: newJobId(), protectedObjectId: object.id, kind: "verify" },
          object.id,
        ),
      );
    case "retention":
      return [planned("retention", { ...base, jobId: newJobId() }, null)];
    case "scrub":
      return [planned("scrub", { ...base, jobId: newJobId(), mode: scrubModeFor(schedule) }, null)];
    case "directory":
      return [...usableSources.values()]
        .filter((source) => source.kind === "m365")
        .map((source) =>
          planned("directory", { ...base, jobId: newJobId(), sourceId: source.id }, null),
        );
    case "archive": {
      if (schedule.protectedObjectId !== null) {
        return objects
          .filter((object) => object.kind !== "onedrive")
          .map((object) => {
            const source = usableSources.get(object.sourceId);
            const capture = source?.kind === "imap" ? "imap_sync" : "graph_sync";
            return planned(
              "archive",
              { ...base, jobId: newJobId(), protectedObjectId: object.id, capture },
              object.id,
            );
          });
      }
      return [...usableSources.values()].map((source) =>
        planned(
          "archive",
          {
            ...base,
            jobId: newJobId(),
            sourceId: source.id,
            capture: source.kind === "imap" ? "imap_sync" : "graph_sync",
          },
          null,
        ),
      );
    }
    default:
      return assertNever(schedule.kind);
  }
}

function assertNever(kind: never): never {
  throw new Error(`unknown schedule kind ${String(kind)}`);
}

export type { ScheduleKind };
