/**
 * A bare metal recovery that reads an endpoint's repository (docs/BAREMETAL.md 9.7): the ISO's
 * restic runs with `--no-lock`, so the server keeps its own maintenance away while a session is
 * `active` or `finishing` and has not expired. Retention and the removal of a machine's backups
 * ask before they take the repository and again once they hold it, and fail with
 * {@link EndpointRecoveryActiveError}; pg-boss retries them later. A session that waits for its
 * release (`pending_approval`) does not hold anything: a stolen code alone must not stop pruning.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { EndpointRepositoryBusyError } from "./repository-lock.js";

type Executor = Pick<NodePgDatabase<Record<string, unknown>>, "execute">;

/** The running recovery session of an endpoint, if one holds its repository at `now`. */
export async function activeRecoveryOf(
  executor: Executor,
  endpointId: string,
  now: Date,
): Promise<{ id: string; expiresAt: Date } | null> {
  const result = await executor.execute<{ id: string; expires_at: Date | string }>(
    sql`SELECT id, expires_at FROM endpoint_recoveries
         WHERE endpoint_id = ${endpointId} AND status IN ('active', 'finishing')
           AND expires_at > ${now.toISOString()}::timestamptz
         ORDER BY expires_at DESC LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

/** A job that must not run while a recovery reads the repository; retried like a busy one. */
export class EndpointRecoveryActiveError extends EndpointRepositoryBusyError {
  constructor(
    endpointId: string,
    readonly recoveryId: string,
  ) {
    super(endpointId);
    this.name = "EndpointRecoveryActiveError";
    this.message = `a recovery of endpoint ${endpointId} reads its repository`;
  }
}
