import { SERVICE_LIMIT_CAUSES } from "@restow/core";
import { jobs } from "@restow/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * A failed job that a service held back (@restow/core `SERVICE_LIMIT_CAUSES`): Graph throttled
 * or unavailable, the storage asking to slow down. Read where failed jobs are counted, so such
 * a run is not counted as failed.
 */
export function serviceLimitedJob(): SQL {
  return sql`(${jobs.status} = 'failed' and coalesce(${jobs.failure}->>'code', '') in (${sql.join(
    SERVICE_LIMIT_CAUSES.map((code) => sql`${code}`),
    sql`, `,
  )}))`;
}

/** Every job but a failed one a service held back. */
export function notServiceLimitedJob(): SQL {
  return sql`not ${serviceLimitedJob()}`;
}
