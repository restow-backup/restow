/**
 * Jobs a worker left behind (#46).
 *
 * A worker that is killed instead of stopped (Docker's stop timeout ran out, the
 * host lost power, the container was removed) cannot fail its jobs: pg-boss keeps
 * them `active` until their expiration (23 hours for a backup), and their `jobs`
 * rows say "running" all that time. Nothing else reconciles them.
 *
 * This pass does, two minutes after the worker's start (every live worker has sent its
 * heartbeat by then) and every five minutes after:
 *
 *   orphaned   a pg-boss job of a Restow queue that is `active` but started before
 *              every live worker did (service_heartbeats: none of them can be running
 *              it) goes back to its queue at once, with its attempt given back (the
 *              stop was not the job's doing); its row becomes `queued`, explained as
 *              an interruption. Its next attempt continues from its checkpoint.
 *   settled    a row still `active` whose pg-boss job is no longer active (pg-boss
 *              expired it, or it is gone) takes the state pg-boss has: `queued` when a
 *              retry follows, else `failed`, explained as the last attempt.
 *
 * A job whose queue policy keeps one waiting job per object (`stately`) and that
 * already has one waiting is left to pg-boss' expiration: the waiting one covers it, as
 * is a job of a worker that died while another one that started before it still runs
 * (nothing tells which of the two had it).
 * Runs on the installation pool, which owns pg-boss' schema and bypasses Row Level
 * Security for the rows of every tenant. One worker at a time runs the pass (a session advisory
 * lock); the others skip it. Both lookups of `jobs` read the partial index of the active rows
 * (`jobs_active_boss_idx`), not the table.
 */
import type { Logger } from "@restow/core";
import { type Database, type FailureRecordJson, safeErrorMessage } from "@restow/db";
import { sql } from "drizzle-orm";
import { jobFailureRecord, retryStateOf } from "./failure.js";
import { QUEUE_NAMES } from "./queues.js";

/** A worker counts as live while its heartbeat is this fresh (it beats every 30 seconds). */
export const LIVE_WORKER_MS = 2 * 60 * 1000;
/** A row is settled only when nothing touched it for this long. */
export const SETTLE_AFTER_MS = 2 * 60 * 1000;
/** How often the pass runs. */
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 0x72636e31; // "rcn1"

export interface ReconcileSummary {
  requeued: number;
  settled: number;
}

/** Why the worker stopped, as the job's explanation says. */
class WorkerGoneError extends Error {
  constructor() {
    super("The worker stopped without finishing the job (it was killed or lost).");
    this.name = "WorkerGoneError";
  }
}

function interruption(
  queue: string,
  now: Date,
  retry: FailureRecordJson["retry"],
): FailureRecordJson {
  return jobFailureRecord({
    error: new WorkerGoneError(),
    queue,
    now,
    step: null,
    abortReason: "shutdown",
    retry,
  });
}

interface OrphanRow extends Record<string, unknown> {
  id: string;
  name: string;
  retry_count: number;
  retry_limit: number;
  retry_delay: number;
  retry_backoff: boolean;
}

interface StuckRow extends Record<string, unknown> {
  job_id: string;
  queue: string;
  boss_state: string | null;
  retry_count: number | null;
  retry_limit: number | null;
  retry_delay: number | null;
  retry_backoff: boolean | null;
}

/**
 * One pass. `selfStartedAt` is when this worker started: until its first heartbeat
 * it is live as well.
 */
export async function reconcileJobs(
  providerDb: Database,
  options: { now: Date; selfStartedAt: Date; logger: Logger },
): Promise<ReconcileSummary> {
  const { now, logger } = options;
  const queues = [...QUEUE_NAMES];
  const live = await providerDb.execute<{ oldest: Date | null }>(sql`
    SELECT min(started_at) AS oldest FROM service_heartbeats
     WHERE role = 'worker' AND beat_at > ${new Date(now.getTime() - LIVE_WORKER_MS).toISOString()}::timestamptz`);
  const oldestLive = live.rows[0]?.oldest ? new Date(live.rows[0].oldest) : null;
  const cutoff =
    oldestLive && oldestLive.getTime() < options.selfStartedAt.getTime()
      ? oldestLive
      : options.selfStartedAt;

  // Orphaned: active in pg-boss, started before every live worker.
  const orphans = await providerDb.execute<OrphanRow>(sql`
    SELECT id::text AS id, name, retry_count, retry_limit, retry_delay, retry_backoff
      FROM pgboss.job
     WHERE state = 'active'
       AND name IN (${sql.join(
         queues.map((queue) => sql`${queue}`),
         sql`, `,
       )})
       AND started_on < ${cutoff.toISOString()}::timestamptz`);
  let requeued = 0;
  for (const orphan of orphans.rows) {
    try {
      const moved = await providerDb.transaction(async (tx) => {
        const result = await tx.execute<OrphanRow>(sql`
          UPDATE pgboss.job
             SET state = 'retry',
                 start_after = now(),
                 retry_limit = CASE WHEN retry_count > 0 THEN retry_limit ELSE retry_limit + 1 END,
                 retry_count = CASE WHEN retry_count > 0 THEN retry_count - 1 ELSE retry_count END
           WHERE name = ${orphan.name} AND id = ${orphan.id}::uuid AND state = 'active'
             AND started_on < ${cutoff.toISOString()}::timestamptz
          RETURNING id::text AS id, name, retry_count, retry_limit, retry_delay, retry_backoff`);
        const job = result.rows[0];
        if (!job) {
          return false;
        }
        const failure = interruption(
          job.name,
          now,
          retryStateOf(
            {
              retryCount: Number(job.retry_count),
              retryLimit: Number(job.retry_limit),
              retryDelay: 0,
              retryBackoff: false,
            },
            now,
          ),
        );
        await tx.execute(sql`
          UPDATE jobs
             SET status = 'queued',
                 failure = ${JSON.stringify(failure)}::jsonb,
                 error_message = ${new WorkerGoneError().message},
                 updated_at = now()
           WHERE pg_boss_job_id = ${job.id} AND status = 'active'`);
        return true;
      });
      if (moved) {
        requeued++;
      }
    } catch (error) {
      // A stately queue already holds a waiting job for the same object: that one runs.
      logger.debug("an orphaned job stays with pg-boss' expiration", {
        queue: orphan.name,
        errorMessage: safeErrorMessage(error),
      });
    }
  }

  // Settled: the row says active, pg-boss no longer does.
  const stuck = await providerDb.execute<StuckRow>(sql`
    SELECT j.id::text AS job_id, j.queue::text AS queue, b.state::text AS boss_state,
           b.retry_count, b.retry_limit, b.retry_delay, b.retry_backoff
      FROM jobs j
      LEFT JOIN pgboss.job b
        ON b.id::text = j.pg_boss_job_id AND b.name = j.queue::text
     WHERE j.status = 'active'
       AND j.pg_boss_job_id IS NOT NULL
       AND j.updated_at < ${new Date(now.getTime() - SETTLE_AFTER_MS).toISOString()}::timestamptz
       AND (b.id IS NULL OR b.state NOT IN ('active', 'completed', 'cancelled'))`);
  let settled = 0;
  for (const row of stuck.rows) {
    const retries = row.boss_state === "created" || row.boss_state === "retry";
    const failure = interruption(
      row.queue,
      now,
      retries
        ? retryStateOf(
            {
              retryCount: Number(row.retry_count ?? 0),
              retryLimit: Number(row.retry_limit ?? 0),
              retryDelay: Number(row.retry_delay ?? 0),
              retryBackoff: row.retry_backoff === true,
            },
            now,
          )
        : null,
    );
    const result = await providerDb.execute(sql`
      UPDATE jobs
         SET status = ${retries ? "queued" : "failed"}::job_status,
             failure = ${JSON.stringify(failure)}::jsonb,
             error_message = ${new WorkerGoneError().message},
             completed_at = ${retries ? null : now.toISOString()}::timestamptz,
             updated_at = now()
       WHERE id = ${row.job_id}::uuid AND status = 'active'`);
    settled += result.rowCount ?? 0;
  }
  if (requeued + settled > 0) {
    logger.warn("jobs a stopped worker left behind were reconciled", { requeued, settled });
  }
  return { requeued, settled };
}

/** One pass, unless another worker runs it right now (then null). */
export async function reconcileJobsOnce(
  providerDb: Database,
  options: { now: Date; selfStartedAt: Date; logger: Logger },
): Promise<ReconcileSummary | null> {
  const client = await providerDb.$client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      return null;
    }
    try {
      return await reconcileJobs(providerDb, options);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Run the pass now and every few minutes; returns a stop function. */
export function startJobReconciler(
  providerDb: Database,
  options: { selfStartedAt: Date; logger: Logger; intervalMs?: number; firstAfterMs?: number },
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    try {
      await reconcileJobsOnce(providerDb, { ...options, now: new Date() });
    } catch (error) {
      options.logger.warn("reconciling left-behind jobs failed", {
        errorMessage: safeErrorMessage(error),
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), options.intervalMs ?? RECONCILE_INTERVAL_MS);
        timer.unref();
      }
    }
  };
  timer = setTimeout(() => void tick(), options.firstAfterMs ?? LIVE_WORKER_MS);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}
