import { isServiceLimitedFailure, SERVICE_LIMIT_CAUSES } from "@restow/core";
import { jobs } from "@restow/db";
import { type SQL, sql } from "drizzle-orm";

/** The queue whose held-back runs the next scheduled run repeats (see `serviceLimitedJob`). */
export const SERVICE_LIMITED_QUEUE = "backup";

/**
 * True for a failed backup a service held back, the rule `serviceLimitedJob` reads in SQL: only
 * a backup has a next scheduled run that tries again, so only a backup reads "held back".
 */
export function isServiceLimitedBackup(job: {
  readonly queue: string;
  readonly status: string;
  readonly failure: { readonly code?: string | null } | null | undefined;
}): boolean {
  return job.queue === SERVICE_LIMITED_QUEUE && isServiceLimitedFailure(job.status, job.failure);
}

function limitedWhere(queue: SQL, status: SQL, failure: SQL): SQL {
  return sql`(${queue} = ${SERVICE_LIMITED_QUEUE} and ${status} = 'failed' and coalesce(${failure}->>'code', '') in (${sql.join(
    SERVICE_LIMIT_CAUSES.map((code) => sql`${code}`),
    sql`, `,
  )}))`;
}

/**
 * A failed backup that a service held back (@restow/core `SERVICE_LIMIT_CAUSES`): Graph
 * throttled or unavailable, the storage asking to slow down. Read where failed jobs are counted,
 * so such a run is not counted as failed. Backups only, as the worker's `backup.failed`
 * suppression reads it: the next scheduled run tries a backup again, while a restore, export,
 * import or check that a service held back has ended for good and stays a failure (it still
 * raises `restore.failed` and the like).
 */
export function serviceLimitedJob(): SQL {
  return limitedWhere(sql`${jobs.queue}`, sql`${jobs.status}`, sql`${jobs.failure}`);
}

/** Every job but a failed backup a service held back. */
export function notServiceLimitedJob(): SQL {
  return sql`not ${serviceLimitedJob()}`;
}

/**
 * `notServiceLimitedJob` for raw SQL that reads the jobs table under an alias (`jobs j`), where
 * drizzle's column references (`"jobs"."status"`) do not resolve.
 */
export function notServiceLimitedJobRaw(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) {
    throw new Error(`not a table alias: ${alias}`);
  }
  return sql`not ${limitedWhere(
    sql.raw(`${alias}.queue`),
    sql.raw(`${alias}.status`),
    sql.raw(`${alias}.failure`),
  )}`;
}
