/**
 * Restow job queues as seen by pg-boss.
 *
 * Names, priorities and payload shapes are the shared contract in
 * @restow/core (engine/jobs.ts); this module adds what only the queue runtime
 * cares about: the per-queue pg-boss policy, retry and expiry settings.
 * The list must stay in sync with the `job_queue` enum in @restow/db.
 */
import {
  JOB_PRIORITY,
  JOB_QUEUES,
  type JobPayloads,
  type JobQueue,
  isJobQueue,
  singletonKeyFor,
} from "@restow/core";
import type PgBoss from "pg-boss";

/** All Restow queue names, in `job_queue` enum order. */
export const QUEUE_NAMES = JOB_QUEUES;

/** A single Restow job queue name. */
export type QueueName = JobQueue;

/** Scheduling priority per queue (higher runs first). */
export const QUEUE_PRIORITY = JOB_PRIORITY;

/** Priority for a queue, to be passed as pg-boss `SendOptions.priority`. */
export function queuePriority(queue: QueueName): number {
  return QUEUE_PRIORITY[queue];
}

/** Narrow an arbitrary string to a known {@link QueueName}. */
export const isQueueName = isJobQueue;

export type QueuePolicy = "standard" | "short" | "singleton" | "stately";

/** pg-boss queue settings: how jobs on a queue dedupe, retry and expire. */
export interface QueueDefinition {
  /** `stately` = at most one queued and one active job per singleton key. */
  readonly policy: QueuePolicy;
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  /** A handler is raced against this; long backups need hours, not pg-boss' 15-minute default (max 23). */
  readonly expireInHours: number;
  /** How long finished jobs stay in pg-boss for inspection. */
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

export const QUEUE_DEFINITIONS: Record<QueueName, QueueDefinition> = {
  backup: LONG_RUNNING,
  // Restores are individual user requests: never deduplicated, retried a little
  // (a transient Graph error must not fail a recovery), kept longer for audit.
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
  // A tenant-initiated storage migration (docs/STORAGE.md, "Replace the
  // primary"): user-facing like restore, but a bounded background copy+verify
  // pass, so it takes the long-running policy (mirrors apps/scheduler/src/
  // queues.ts, which already carries this entry).
  storage_migration: LONG_RUNNING,
  // Reading a multi-GB mail file takes hours; checkpoints let the retry resume.
  import: LONG_RUNNING,
  // Like a restore: a person's request, never deduplicated, a little retry.
  export: {
    policy: "standard",
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInHours: MAX_EXPIRE_HOURS,
    retentionDays: 30,
  },
};

/** The pg-boss `createQueue` / `updateQueue` options for a queue. */
export function pgBossQueueOptions(queue: QueueName): PgBoss.Queue {
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

/** Send options (priority + singleton key) for enqueuing a payload on a queue. */
export function sendOptionsFor<Q extends QueueName>(
  queue: Q,
  payload: JobPayloads[Q],
): PgBoss.SendOptions {
  const singletonKey = singletonKeyFor(queue, payload);
  return {
    priority: queuePriority(queue),
    ...(singletonKey ? { singletonKey } : {}),
  };
}
