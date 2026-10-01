// The job contract as the scheduler sees it.
//
// The authoritative definitions live in @restow/core (engine/jobs.ts: queue
// names, priorities, payload shapes, singleton keys) and apps/worker
// (queues.ts: pg-boss policies). The scheduler has no dependency on either
// package, so the parts it needs are mirrored here. Keep the three in sync;
// a mismatch shows up as a handler rejecting a payload.

import type { jobQueueEnum } from "@restow/db";
import type PgBoss from "pg-boss";

/** The full set of pg-boss queue names, sourced from the database enum. */
export type JobQueue = (typeof jobQueueEnum.enumValues)[number];

export const JOB_QUEUES = [
  "backup",
  "restore",
  "verify",
  "archive",
  "directory",
  "retention",
  "scrub",
  "storage_migration",
  "import",
  "export",
] as const satisfies readonly JobQueue[];

/**
 * pg-boss priority per queue (higher first): restore > verify > backup;
 * storage_migration ranks below restore and backup, above scrub (mirror of
 * @restow/core engine/jobs.ts JOB_PRIORITY).
 */
export const JOB_PRIORITY: Record<JobQueue, number> = {
  restore: 100,
  export: 90,
  verify: 80,
  archive: 60,
  import: 50,
  backup: 40,
  directory: 30,
  storage_migration: 25,
  retention: 20,
  scrub: 10,
};

type QueuePolicy = "standard" | "short" | "singleton" | "stately";

interface QueueDefinition {
  readonly policy: QueuePolicy;
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  readonly expireInHours: number;
  readonly retentionDays: number;
}

/**
 * pg-boss refuses expirations of 24 hours or more. A job that needs longer
 * checkpoints before this deadline (the worker aborts it at 95%) and continues
 * in its retry, so multi-day initial backups still complete.
 */
export const MAX_EXPIRE_HOURS = 23;

const LONG_RUNNING: QueueDefinition = {
  policy: "stately",
  retryLimit: 5,
  retryDelaySeconds: 60,
  retryBackoff: true,
  expireInHours: MAX_EXPIRE_HOURS,
  retentionDays: 14,
};

const HOUSEKEEPING: QueueDefinition = {
  policy: "stately",
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  expireInHours: 12,
  retentionDays: 14,
};

/** Mirror of apps/worker/src/queues.ts QUEUE_DEFINITIONS. */
export const QUEUE_DEFINITIONS: Record<JobQueue, QueueDefinition> = {
  backup: LONG_RUNNING,
  restore: {
    policy: "standard",
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInHours: MAX_EXPIRE_HOURS,
    retentionDays: 30,
  },
  verify: HOUSEKEEPING,
  archive: LONG_RUNNING,
  directory: { ...HOUSEKEEPING, expireInHours: 2 },
  retention: HOUSEKEEPING,
  scrub: { ...HOUSEKEEPING, expireInHours: MAX_EXPIRE_HOURS },
  // Copies a tenant's backups to another storage target; can run for hours,
  // same as a backup. No handler yet: the worker handler ships separately,
  // like `archive` did before its handler existed — the queue exists end to
  // end before anything processes it.
  storage_migration: LONG_RUNNING,
  // Mail file import and export (docs/IMPORT.md); the worker owns both handlers.
  import: LONG_RUNNING,
  export: {
    policy: "standard",
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInHours: MAX_EXPIRE_HOURS,
    retentionDays: 30,
  },
};

export function pgBossQueueOptions(queue: JobQueue): PgBoss.Queue {
  const def = QUEUE_DEFINITIONS[queue];
  return {
    name: queue,
    policy: def.policy,
    retryLimit: def.retryLimit,
    retryDelay: def.retryDelaySeconds,
    retryBackoff: def.retryBackoff,
    expireInHours: def.expireInHours,
    retentionDays: def.retentionDays,
  };
}

// Payload shapes (mirror of @restow/core engine/jobs.ts).

export interface JobPayloadBase {
  readonly jobId: string;
  readonly tenantId: string;
  readonly scheduleId?: string;
}

export interface BackupJobPayload extends JobPayloadBase {
  readonly protectedObjectId: string;
  readonly full?: boolean;
}

export interface VerifyJobPayload extends JobPayloadBase {
  readonly protectedObjectId: string;
  readonly kind: "verify" | "health_check";
  readonly sampleSize?: number;
}

export interface ArchiveJobPayload extends JobPayloadBase {
  readonly protectedObjectId?: string;
  readonly sourceId?: string;
  readonly capture: "graph_sync" | "imap_sync";
}

export interface DirectoryJobPayload extends JobPayloadBase {
  readonly sourceId: string;
}

export interface RetentionJobPayload extends JobPayloadBase {
  readonly dryRun?: boolean;
}

export interface ScrubJobPayload extends JobPayloadBase {
  readonly mode: "sample" | "full";
}

/**
 * Payloads of the queues the scheduler enqueues on a cron. `restore` and
 * `storage_migration` are event-driven instead (a user request, an admin
 * starting a migration): they still get a pg-boss queue definition above, but
 * no schedule ever sends into them.
 */
export interface ScheduledPayloads {
  backup: BackupJobPayload;
  verify: VerifyJobPayload;
  archive: ArchiveJobPayload;
  directory: DirectoryJobPayload;
  retention: RetentionJobPayload;
  scrub: ScrubJobPayload;
}

export type ScheduledQueue = keyof ScheduledPayloads;
export type ScheduledPayload = ScheduledPayloads[ScheduledQueue];

/** Mirror of @restow/core singletonKeyFor for the scheduled queues. */
export function singletonKeyFor<Q extends ScheduledQueue>(
  queue: Q,
  payload: ScheduledPayloads[Q],
): string {
  switch (queue) {
    case "backup":
    case "verify":
      return `${queue}:${(payload as BackupJobPayload | VerifyJobPayload).protectedObjectId}`;
    case "archive": {
      const archive = payload as ArchiveJobPayload;
      const target = archive.protectedObjectId ?? archive.sourceId ?? "tenant";
      return `archive:${payload.tenantId}:${target}`;
    }
    case "directory":
      return `directory:${(payload as DirectoryJobPayload).sourceId}`;
    default:
      return `${queue}:${payload.tenantId}`;
  }
}

/** Send options for a scheduled job: priority plus the singleton key. */
export function sendOptionsFor<Q extends ScheduledQueue>(
  queue: Q,
  payload: ScheduledPayloads[Q],
): PgBoss.SendOptions {
  return { priority: JOB_PRIORITY[queue], singletonKey: singletonKeyFor(queue, payload) };
}
