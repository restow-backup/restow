// Login probes of shut-down IMAP accounts (docs/IMAP.md "Anmeldung abgelehnt: Konto abgeschaltet?"):
// an account an admin confirmed as shut down (`orphaned` with the reason `login_refused`) is not
// backed up, but its login is tried once a week, so that an account the hoster brings back
// resumes by itself. The scheduler decides which probes are due and queues one normal `backup`
// job per account; the backup handler logs in first and goes on into the backup when it works
// (apps/worker handlers/backup.ts `probeLoginRefused`).
//
// What is due comes from the object rows alone: `login_probe_due_at`. It is deliberately not
// planned through the schedules or the mail jobs: an account that sits only in an archive-only
// job, in a paused job or in no job at all would never be probed there, and every probe would
// land in that job's run history. A probe is a job without a backup job.
//
// The planner never moves the due time. The worker does: a refused probe sets it a week out, a
// doubtful answer (network, server limit) a day out, a working login reactivates the account
// and clears it, and a new password sets it to now (apps/api). pg-boss' singleton key is the one
// of every backup of the object, so a probe never overlaps a "Back up now" or a scheduled run,
// and `singletonSeconds` keeps a worker that is down from being flooded every minute.

import { randomUUID } from "node:crypto";
import type { Database } from "@restow/db";
import type { PoolClient } from "pg";
import type PgBoss from "pg-boss";
import { errorMessage, logger } from "./logger.js";
import { sendOptionsFor } from "./queues.js";

type Pool = Database["$client"];

/** A probe still waiting in the queue is not queued again within this long. */
const SPACING_SECONDS = 60 * 60;
/** Probes queued per planning pass. */
const MAX_PER_PASS = 200;

interface DueProbe {
  id: string;
  tenant_id: string;
}

export interface LoginProbePools {
  /** Application pool: the jobs rows of one tenant are written in a transaction pinned to it. */
  readonly tenant: Pool;
  /** Installation pool (BYPASSRLS): the one query across tenants. */
  readonly installation: Pool;
}

export class LoginProbePlanner {
  private lastPlanned = 0;

  constructor(
    private readonly pools: LoginProbePools,
    private readonly boss: PgBoss,
    /** How often a planning pass runs; the tick loop is more frequent. */
    private readonly intervalMs = 60_000,
    private readonly newJobId: () => string = randomUUID,
  ) {}

  /**
   * The shut-down accounts whose probe is due: active tenants, IMAP sources that can be reached
   * (`active`, or `error` after a failed check: the engine's own failure is the better
   * diagnosis; never `disabled` or `pending`), oldest due first.
   */
  async due(now: Date): Promise<DueProbe[]> {
    const { rows } = await this.pools.installation.query<DueProbe>(
      `SELECT po.id, po.tenant_id
         FROM protected_objects po
         JOIN tenants t ON t.id = po.tenant_id
         JOIN sources s ON s.id = po.source_id
        WHERE t.status = 'active'
          AND po.kind = 'imap'
          AND po.status = 'orphaned'
          AND po.status_reason = 'login_refused'
          AND po.login_probe_due_at <= $1
          AND s.kind = 'imap'
          AND s.status IN ('active', 'error')
        ORDER BY po.login_probe_due_at, po.id
        LIMIT ${MAX_PER_PASS}`,
      [now],
    );
    return rows;
  }

  /** Queue one backup job (the probe) for the account; false when one is already queued. */
  private async queue(probe: DueProbe): Promise<boolean> {
    const payload = {
      jobId: this.newJobId(),
      tenantId: probe.tenant_id,
      protectedObjectId: probe.id,
    };
    const client = await this.pools.tenant.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [probe.tenant_id]);
      const pgBossJobId = await this.boss.send("backup", payload, {
        ...sendOptionsFor("backup", payload),
        singletonSeconds: SPACING_SECONDS,
        db: bossDb(client),
      });
      if (pgBossJobId === null) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO jobs (id, tenant_id, queue, status, protected_object_id, payload, pg_boss_job_id)
         VALUES ($1, $2, 'backup', 'queued', $3, $4, $5)`,
        [payload.jobId, probe.tenant_id, probe.id, JSON.stringify(payload), pgBossJobId],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** One planning pass (a pass less than `intervalMs` after the last does nothing); returns the probes queued. */
  async plan(now: Date): Promise<number | null> {
    if (now.getTime() - this.lastPlanned < this.intervalMs) {
      return null;
    }
    this.lastPlanned = now.getTime();
    let queued = 0;
    try {
      for (const probe of await this.due(now)) {
        try {
          if (await this.queue(probe)) queued++;
        } catch (error) {
          logger.error("queueing a login probe failed", {
            protectedObjectId: probe.id,
            err: errorMessage(error),
          });
        }
      }
    } catch (error) {
      logger.error("planning login probes failed", { err: errorMessage(error) });
    }
    return queued;
  }
}

function bossDb(client: PoolClient): PgBoss.Db {
  return {
    executeSql: async (text, values) => {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };
}
