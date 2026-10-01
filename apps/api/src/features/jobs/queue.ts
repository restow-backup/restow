import { JOB_PRIORITY, type JobPayloads, type JobQueue, singletonKeyFor } from "@restow/core";
import type { Database } from "@restow/db";
import PgBoss from "pg-boss";
import { db } from "../../db.js";
import type { Transaction } from "../../lib/tenant-context.js";
import { pgBossExecutor } from "./pg-boss-tx.js";

/**
 * The API's hand on the job queue. It never runs jobs, so the pg-boss
 * instance is never started: `send` and `cancel` are plain statements that
 * go through the executor we give them, which is either the request's
 * tenant-pinned transaction (enqueue) or the shared pool (cancel).
 *
 * Queue policies, priorities and singleton keys are the worker's contract
 * (@restow/core engine/jobs.ts, apps/worker/src/queues.ts); the API only
 * reuses them. A `stately` queue refuses a second queued job with the same
 * singleton key, which surfaces here as `null` from {@link sendJob}.
 */

const instances = new WeakMap<object, PgBoss>();

/** A pg-boss bound to the database's pool (for statements outside a transaction). */
export function jobQueue(database: Database = db): PgBoss {
  const pool = database.$client;
  let boss = instances.get(pool);
  if (!boss) {
    boss = new PgBoss({
      db: {
        executeSql: async (text, values) => {
          const result = await pool.query(text, values);
          return { rows: result.rows };
        },
      },
    });
    instances.set(pool, boss);
  }
  return boss;
}

/** The send options the worker expects: queue priority plus the singleton key. */
export function sendOptionsFor<Q extends JobQueue>(
  queue: Q,
  payload: JobPayloads[Q],
): PgBoss.SendOptions {
  const singletonKey = singletonKeyFor(queue, payload);
  return { priority: JOB_PRIORITY[queue], ...(singletonKey ? { singletonKey } : {}) };
}

/**
 * Enqueue `payload` inside `tx`. Returns pg-boss' job id, or null when the
 * queue already holds a queued or active job with the same singleton key
 * (the caller then reports "already queued" instead of inserting a row).
 */
export async function sendJob<Q extends JobQueue>(
  tx: Transaction,
  queue: Q,
  payload: JobPayloads[Q],
  database: Database = db,
): Promise<string | null> {
  const id = await jobQueue(database).send(queue, payload, {
    ...sendOptionsFor(queue, payload),
    db: pgBossExecutor(tx),
  });
  return id ?? null;
}

/**
 * 42P01 undefined_table, 3F000 invalid_schema_name: pg-boss never ran against
 * this database yet (a fresh install before the worker's first start). A
 * caller that must not fail its own change over this reports "not queued"
 * instead of letting the error surface as a 500.
 */
export function isMissingQueueSchema(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  const code = candidate?.code ?? candidate?.cause?.code;
  return code === "42P01" || code === "3F000";
}

/** Cancel a queued pg-boss job so the worker never picks it up. Safe on already-running jobs. */
export async function cancelQueuedJob(
  queue: JobQueue,
  pgBossJobId: string,
  database: Database = db,
): Promise<void> {
  await jobQueue(database).cancel(queue, pgBossJobId);
}
