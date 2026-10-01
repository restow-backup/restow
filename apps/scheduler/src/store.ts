// Database access for the scheduler, on plain SQL over two pools.
//
// Reading due schedules is the one deliberately cross-tenant query in Restow:
// it runs on the installation pool (BYPASSRLS) and sees every tenant's
// schedules in one pass. Everything done for one tenant (reading its targets,
// enqueueing, advancing the schedule) runs on the application pool, in a
// transaction pinned with `app.tenant_id`, so the per-tenant RLS policies apply
// to everything the scheduler reads and inserts for that tenant.
//
// Enqueueing is atomic per schedule: the pg-boss job rows, the Restow `jobs`
// rows and the schedule's next run are written in one transaction, using
// pg-boss' `db` option to route its insert through the same connection. If a
// singleton key is already queued or active, pg-boss returns null and no
// `jobs` row is created; the schedule still advances.
//
// The recommended schedules are applied the same way: found across tenants on
// the installation pool, written per tenant on the application pool in one
// pinned transaction together with the tenant's marker.

import {
  type ExistingSchedule,
  missingRecommendedSchedules,
  nextRunAt,
  recommendedSchedules,
} from "@restow/core";
import type { Database } from "@restow/db";
import type { PoolClient } from "pg";
import type PgBoss from "pg-boss";
import type { PlannedJob, ScheduleRow, TenantTargets } from "./planning.js";
import { sendOptionsFor } from "./queues.js";

type Pool = Database["$client"];

interface ScheduleRecord {
  id: string;
  tenant_id: string;
  protected_object_id: string | null;
  kind: ScheduleRow["kind"];
  interval_minutes: number | null;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  next_run_at: Date | null;
  last_run_at: Date | null;
}

function toScheduleRow(record: ScheduleRecord): ScheduleRow {
  return {
    id: record.id,
    tenantId: record.tenant_id,
    protectedObjectId: record.protected_object_id,
    kind: record.kind,
    intervalMinutes: record.interval_minutes,
    cron: record.cron,
    timezone: record.timezone,
    enabled: record.enabled,
    nextRunAt: record.next_run_at,
    lastRunAt: record.last_run_at,
  };
}

export interface EnqueueResult {
  /** Jobs handed to pg-boss and recorded in `jobs`. */
  readonly enqueued: number;
  /** Jobs skipped because the same singleton key is already queued or active. */
  readonly skipped: number;
}

/** What applying the recommended schedules to one tenant did. */
export interface DefaultsResult {
  /** False when another process applied them first (the marker was already set). */
  readonly applied: boolean;
  /** Kinds of the schedules created, in order (empty when every one existed already). */
  readonly created: readonly ExistingSchedule["kind"][];
}

/** The application pool (subject to RLS) and the installation pool (BYPASSRLS). */
export interface SchedulePools {
  readonly tenant: Pool;
  readonly installation: Pool;
}

export class ScheduleStore {
  private readonly pool: Pool;
  private readonly installation: Pool;

  /** One pool for both (tests running as the owner), or the two pools of a real process. */
  constructor(pools: Pool | SchedulePools) {
    const split = "installation" in pools ? pools : { tenant: pools, installation: pools };
    this.pool = split.tenant;
    this.installation = split.installation;
  }

  /** Enabled schedules of active tenants whose next run is at or before `now` (across tenants). */
  async loadDue(now: Date, limit: number): Promise<ScheduleRow[]> {
    const result = await this.installation.query<ScheduleRecord>(
      `SELECT s.id, s.tenant_id, s.protected_object_id, s.kind, s.interval_minutes, s.cron,
              s.timezone, s.enabled, s.next_run_at, s.last_run_at
         FROM schedules s
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.enabled
          AND t.status = 'active'
          AND (s.next_run_at IS NULL OR s.next_run_at <= $1)
        ORDER BY s.next_run_at NULLS FIRST, s.created_at
        LIMIT $2`,
      [now, limit],
    );
    return result.rows.map(toScheduleRow);
  }

  /**
   * Active tenants that have an active source and have not received the
   * recommended schedules yet (across tenants, oldest first).
   */
  async loadTenantsAwaitingDefaults(limit: number): Promise<string[]> {
    const result = await this.installation.query<{ id: string }>(
      `SELECT t.id
         FROM tenants t
        WHERE t.status = 'active'
          AND t.schedule_defaults_applied_at IS NULL
          AND EXISTS (
                SELECT 1 FROM sources s
                 WHERE s.tenant_id = t.id AND s.status = 'active' AND s.kind <> 'import')
        ORDER BY t.created_at, t.id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }

  /**
   * Give one tenant the recommended schedules it does not have yet and set its
   * marker, in one transaction pinned to the tenant. The tenant row is locked
   * first, so a concurrent apply (another scheduler, the API's "apply
   * recommended") waits and then finds the marker set or the schedules there.
   * Interval schedules are due at once, so the first backup and directory
   * sync run in the same tick; cron schedules wait for their local time.
   */
  async applyRecommendedDefaults(
    tenantId: string,
    timezone: string,
    now: Date,
  ): Promise<DefaultsResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const tenant = await client.query<{ schedule_defaults_applied_at: Date | null }>(
        "SELECT schedule_defaults_applied_at FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId],
      );
      const marker = tenant.rows[0];
      if (!marker || marker.schedule_defaults_applied_at !== null) {
        await client.query("COMMIT");
        return { applied: false, created: [] };
      }
      const microsoft = await client.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM sources WHERE tenant_id = $1 AND kind = 'm365') AS present",
        [tenantId],
      );
      const existing = await client.query<{
        kind: ExistingSchedule["kind"];
        protected_object_id: string | null;
        interval_minutes: number | null;
        cron: string | null;
      }>(
        "SELECT kind, protected_object_id, interval_minutes, cron FROM schedules WHERE tenant_id = $1",
        [tenantId],
      );
      const missing = missingRecommendedSchedules(
        existing.rows.map((row) => ({
          kind: row.kind,
          protectedObjectId: row.protected_object_id,
          intervalMinutes: row.interval_minutes,
          cron: row.cron,
        })),
        recommendedSchedules({
          timezone,
          hasMicrosoftSource: microsoft.rows[0]?.present === true,
        }),
      );
      for (const schedule of missing) {
        await client.query(
          `INSERT INTO schedules (tenant_id, kind, interval_minutes, cron, timezone, enabled, next_run_at)
           VALUES ($1, $2, $3, $4, $5, true, $6)`,
          [
            tenantId,
            schedule.kind,
            schedule.intervalMinutes,
            schedule.cron,
            schedule.timezone,
            nextRunAt(schedule, { now }),
          ],
        );
      }
      await client.query("UPDATE tenants SET schedule_defaults_applied_at = $2 WHERE id = $1", [
        tenantId,
        now,
      ]);
      await client.query("COMMIT");
      return { applied: true, created: missing.map((schedule) => schedule.kind) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The protected objects and sources of one tenant, for schedule expansion. */
  async loadTargets(tenantId: string): Promise<TenantTargets> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const objects = await client.query<TenantTargets["protectedObjects"][number]>(
        `SELECT id, source_id AS "sourceId", kind, status
           FROM protected_objects
          WHERE tenant_id = $1`,
        [tenantId],
      );
      const sources = await client.query<TenantTargets["sources"][number]>(
        "SELECT id, kind, status FROM sources WHERE tenant_id = $1",
        [tenantId],
      );
      await client.query("COMMIT");
      return { protectedObjects: objects.rows, sources: sources.rows };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Enqueue the planned jobs of one schedule and advance it, atomically.
   * See the module comment for the singleton semantics.
   */
  async enqueue(
    boss: PgBoss,
    schedule: ScheduleRow,
    jobs: readonly PlannedJob[],
    nextRunAt: Date,
    now: Date,
  ): Promise<EnqueueResult> {
    const client = await this.pool.connect();
    let enqueued = 0;
    let skipped = 0;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [schedule.tenantId]);
      for (const job of jobs) {
        const pgBossJobId = await boss.send(job.queue, job.payload, {
          ...sendOptionsFor(job.queue, job.payload as never),
          db: bossDb(client),
        });
        if (pgBossJobId === null) {
          skipped++;
          continue;
        }
        await client.query(
          `INSERT INTO jobs (id, tenant_id, queue, status, protected_object_id, payload, pg_boss_job_id)
           VALUES ($1, $2, $3, 'queued', $4, $5, $6)`,
          [
            job.payload.jobId,
            schedule.tenantId,
            job.queue,
            job.protectedObjectId,
            JSON.stringify(job.payload),
            pgBossJobId,
          ],
        );
        enqueued++;
      }
      await this.advance(client, schedule.id, now, nextRunAt);
      await client.query("COMMIT");
      return { enqueued, skipped };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Push a schedule's next run without running it (invalid cron expression,
   * planning failure), so one broken row cannot make every tick spin on it.
   */
  async defer(schedule: ScheduleRow, nextRunAt: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [schedule.tenantId]);
      await client.query(
        "UPDATE schedules SET next_run_at = $2, updated_at = now() WHERE id = $1",
        [schedule.id, nextRunAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async advance(
    client: PoolClient,
    scheduleId: string,
    now: Date,
    nextRunAt: Date,
  ): Promise<void> {
    await client.query(
      "UPDATE schedules SET last_run_at = $2, next_run_at = $3, updated_at = now() WHERE id = $1",
      [scheduleId, now, nextRunAt],
    );
  }
}

/** Route pg-boss' SQL through our transaction's connection. */
function bossDb(client: PoolClient): PgBoss.Db {
  return {
    executeSql: async (text, values) => {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };
}
