import {
  isNotBackedUpFailure,
  isServiceLimitedFailure,
  NOT_BACKED_UP_CAUSES,
  notBackedUpReason,
  SERVICE_LIMIT_CAUSES,
} from "@restow/core";
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

/**
 * True for a failed backup that did not back up because the mailbox's account is disabled or
 * unlicensed (@restow/core `NOT_BACKED_UP_CAUSES`), the rule `notCountedFailureJob` reads in SQL.
 */
export function isNotBackedUpBackup(job: {
  readonly queue: string;
  readonly status: string;
  readonly failure: { readonly code?: string | null } | null | undefined;
}): boolean {
  return job.queue === SERVICE_LIMITED_QUEUE && isNotBackedUpFailure(job.status, job.failure);
}

/**
 * Why a backup did not back up (`account_disabled`, `no_license`), for the DTOs' `notBackedUp`
 * flag; null for any other job.
 */
export function notBackedUpOf(job: {
  readonly queue: string;
  readonly status: string;
  readonly failure:
    | { readonly code?: string | null; readonly params?: Record<string, unknown> | null }
    | null
    | undefined;
}): "account_disabled" | "no_license" | null {
  return job.queue === SERVICE_LIMITED_QUEUE ? notBackedUpReason(job.status, job.failure) : null;
}

function limitedWhere(
  queue: SQL,
  status: SQL,
  failure: SQL,
  causes: readonly string[] = SERVICE_LIMIT_CAUSES,
): SQL {
  return sql`(${queue} = ${SERVICE_LIMITED_QUEUE} and ${status} = 'failed' and coalesce(${failure}->>'code', '') in (${sql.join(
    causes.map((code) => sql`${code}`),
    sql`, `,
  )}))`;
}

/** The causes of a failed backup that is not counted as failed: held back or not backed up. */
const NOT_COUNTED_CAUSES: readonly string[] = [...SERVICE_LIMIT_CAUSES, ...NOT_BACKED_UP_CAUSES];

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

/**
 * Every job but a failed backup that is no failure of the object: one a service held back
 * (`serviceLimitedJob`) or one that did not back up because the mailbox's account is disabled
 * or unlicensed (@restow/core `NOT_BACKED_UP_CAUSES`). Read wherever failed backups are counted
 * or the latest run of an object decides whether it is failing: neither kind of run makes it so.
 */
export function notCountedFailureJob(): SQL {
  return sql`not ${limitedWhere(sql`${jobs.queue}`, sql`${jobs.status}`, sql`${jobs.failure}`, NOT_COUNTED_CAUSES)}`;
}

/** `notCountedFailureJob` for raw SQL under a table alias (see `notServiceLimitedJobRaw`). */
export function notCountedFailureJobRaw(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) {
    throw new Error(`not a table alias: ${alias}`);
  }
  return sql`not ${limitedWhere(
    sql.raw(`${alias}.queue`),
    sql.raw(`${alias}.status`),
    sql.raw(`${alias}.failure`),
    NOT_COUNTED_CAUSES,
  )}`;
}
