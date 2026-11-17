// The sealed credentials of database connection tests (docs/DATABASES.md 3.2, 10): a test of the
// Restow server or an agent keeps the credentials it used only while it may use them. A test no
// agent answered ends when it expires; the credentials of a finished test of unsaved settings
// are kept 30 minutes for saving them. The API drops both whenever the tenant asks for its
// tests; this sweep does it for every tenant once a minute, whether anyone asks or not.
//
// One statement on the installation pool (BYPASSRLS): the expired tests end as
// `db_runner_offline` (as in the API), every stale test lets go of its credentials, and those
// secrets are deleted. A row locked by a running request is left for the next pass.

import type { Database } from "@restow/db";
import { errorMessage, logger } from "./logger.js";

type Pool = Database["$client"];

/** The credentials of a finished test of unsaved settings are kept this long. */
export const PROBE_CREDENTIALS_KEEP_MS = 30 * 60 * 1000;
/** Tests handled per pass. */
const MAX_PER_PASS = 500;

export class DatabaseProbeSweeper {
  private lastSwept = 0;

  constructor(
    private readonly installation: Pool,
    /** How often a pass runs; the tick loop is more frequent. */
    private readonly intervalMs = 60_000,
  ) {}

  /** One pass (a pass less than `intervalMs` after the last does nothing); the secrets deleted. */
  async sweep(now: Date): Promise<number | null> {
    if (now.getTime() - this.lastSwept < this.intervalMs) {
      return null;
    }
    this.lastSwept = now.getTime();
    try {
      const { rows } = await this.installation.query<{ deleted: number }>(
        `WITH stale AS (
           SELECT id, tenant_id, credential_secret_id
             FROM database_probes
            WHERE credential_secret_id IS NOT NULL
              AND ((status IN ('pending', 'running') AND expires_at < $1)
                OR (status IN ('done', 'failed', 'expired') AND finished_at < $2))
            ORDER BY created_at
            LIMIT ${MAX_PER_PASS}
            FOR UPDATE SKIP LOCKED
         ), ended AS (
           UPDATE database_probes p
              SET status = CASE WHEN p.status IN ('pending', 'running') THEN 'expired' ELSE p.status END,
                  error_code = CASE WHEN p.status IN ('pending', 'running') THEN 'db_runner_offline' ELSE p.error_code END,
                  finished_at = coalesce(p.finished_at, $1),
                  credential_secret_id = NULL
             FROM stale
            WHERE p.id = stale.id
           RETURNING stale.tenant_id, stale.credential_secret_id AS secret_id
         ), deleted AS (
           DELETE FROM secrets s
            USING ended
            WHERE s.id = ended.secret_id AND s.tenant_id = ended.tenant_id
           RETURNING s.id
         )
         SELECT count(*)::int AS deleted FROM deleted`,
        [now, new Date(now.getTime() - PROBE_CREDENTIALS_KEEP_MS)],
      );
      return rows[0]?.deleted ?? 0;
    } catch (error) {
      logger.error("sweeping the credentials of database tests failed", {
        err: errorMessage(error),
      });
      return 0;
    }
  }
}
