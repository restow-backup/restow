import type { Database } from "@restow/db";
import { sql } from "drizzle-orm";

/**
 * A long job that is interrupted after it made progress continues without
 * using up its retries (#47).
 *
 * A backup that needs longer than pg-boss' expiration (23 hours) is aborted at
 * 95% of it, checkpoints, and continues in its retry; so is one stopped by an
 * update or a restart. Each of those used to count as a failed attempt: after
 * the queue's retry limit (5) a multi-day first backup of a large mailbox ended
 * as failed and its checkpoint was thrown away. Now an interrupted attempt that
 * saved a checkpoint gives its attempt back, for at most
 * {@link MAX_CONTINUATION_DAYS} after the job first started. Attempts that end
 * in a real error, or make no progress, still count.
 *
 * A stop by a shutdown (a restart, an update) or by an update's drain is not
 * the job's doing at all (#46): it gives the attempt back even when the job
 * had not saved a checkpoint yet, within the same days. Otherwise a job on
 * its last attempt ended as failed, its checkpoint discarded, only because
 * someone installed an update while it ran.
 */

/** How long after its first start a job may keep continuing for free. */
export const MAX_CONTINUATION_DAYS = 21;

export interface RetryBudget {
  readonly retryCount: number;
  readonly retryLimit: number;
}

/**
 * Whether an interruption may continue for free: interrupted (time limit,
 * shutdown or an update's drain, never an error or a cancel), a checkpoint
 * saved during the attempt (not needed for a shutdown or an update), and still
 * within {@link MAX_CONTINUATION_DAYS} of the job's first start.
 */
export function mayContinueForFree(input: {
  readonly reason: "expired" | "shutdown" | "update" | "cancelled" | null;
  readonly checkpointed: boolean;
  readonly startedAt: Date | null;
  readonly now: Date;
}): boolean {
  if (input.reason !== "expired" && input.reason !== "shutdown" && input.reason !== "update") {
    return false;
  }
  // The time limit is the job's own: only progress earns the attempt back.
  if (input.reason === "expired" && !input.checkpointed) {
    return false;
  }
  if (!input.startedAt) {
    return false;
  }
  const ageMs = input.now.getTime() - input.startedAt.getTime();
  return ageMs >= 0 && ageMs <= MAX_CONTINUATION_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Give the active pg-boss job its attempt back before the worker fails it:
 * pg-boss counts an attempt when it hands a job out again, so a counted
 * attempt is taken back (`retry_count - 1`); on the first attempt, which has
 * none to take back, the limit grows by one instead. Keeping the count low
 * keeps pg-boss' exponential backoff short as well. Returns the budget the
 * failure is then decided by, or null when the job is no longer active (pg-boss
 * already failed it). Runs on the installation pool, which owns pg-boss' schema.
 */
export async function grantContinuation(
  providerDb: Database,
  queue: string,
  pgBossJobId: string,
): Promise<RetryBudget | null> {
  const result = await providerDb.execute<{ retry_count: number; retry_limit: number }>(sql`
    UPDATE pgboss.job
       SET retry_limit = CASE WHEN retry_count > 0 THEN retry_limit ELSE retry_limit + 1 END,
           retry_count = CASE WHEN retry_count > 0 THEN retry_count - 1 ELSE retry_count END
     WHERE name = ${queue} AND id = ${pgBossJobId}::uuid AND state = 'active'
    RETURNING retry_count, retry_limit`);
  const row = result.rows[0];
  return row ? { retryCount: Number(row.retry_count), retryLimit: Number(row.retry_limit) } : null;
}
