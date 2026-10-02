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
  type JobSchedule,
  jobScheduleFromCadence,
  missingRecommendedSchedules,
  nextRunAt,
  recommendedSchedules,
} from "@restow/core";
import type { Database } from "@restow/db";
import type { PoolClient } from "pg";
import type PgBoss from "pg-boss";
import { defaultMailJobName, languageOf } from "./names.js";
import type {
  BackupJobRow,
  JobMemberRow,
  JobUnit,
  PlannedJob,
  ScheduleRow,
  TenantTargets,
} from "./planning.js";
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
          AND s.superseded_by_job_id IS NULL
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
      const tenant = await client.query<{
        schedule_defaults_applied_at: Date | null;
        language: string | null;
      }>("SELECT schedule_defaults_applied_at, language FROM tenants WHERE id = $1 FOR UPDATE", [
        tenantId,
      ]);
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
      // A mail job that covers every object answers both the backup and the restore-check recommendation.
      const coveredByJob = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM backup_jobs
                         WHERE tenant_id = $1 AND kind = 'mail' AND scope_mode = 'all') AS present`,
        [tenantId],
      );
      const jobCoverage: ExistingSchedule[] =
        coveredByJob.rows[0]?.present === true
          ? (["backup", "verify"] as const).map((kind) => ({
              kind,
              protectedObjectId: null,
              intervalMinutes: null,
              cron: "* * * * *",
            }))
          : [];
      const missing = missingRecommendedSchedules(
        [
          ...existing.rows.map((row) => ({
            kind: row.kind,
            protectedObjectId: row.protected_object_id,
            intervalMinutes: row.interval_minutes,
            cron: row.cron,
          })),
          ...jobCoverage,
        ],
        recommendedSchedules({
          timezone,
          hasMicrosoftSource: microsoft.rows[0]?.present === true,
        }),
      );
      // Backups and restore checks are one job (release 0.2.0); the rest stays a schedule.
      const forJob = missing.filter(
        (schedule) => schedule.kind === "backup" || schedule.kind === "verify",
      );
      for (const schedule of missing) {
        if (schedule.kind === "backup" || schedule.kind === "verify") {
          continue;
        }
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
      const created: ExistingSchedule["kind"][] = missing
        .filter((schedule) => schedule.kind !== "backup" && schedule.kind !== "verify")
        .map((schedule) => schedule.kind);
      if (forJob.length > 0) {
        const backup = forJob.find((schedule) => schedule.kind === "backup");
        const verify = forJob.find((schedule) => schedule.kind === "verify");
        const names = await client.query<{ name: string }>(
          "SELECT name FROM backup_jobs WHERE tenant_id = $1 AND kind = 'mail'",
          [tenantId],
        );
        const name = defaultMailJobName(
          languageOf(marker.language),
          new Set(names.rows.map((row) => row.name)),
        );
        const timer = (schedule: typeof backup) => (schedule ? nextRunAt(schedule, { now }) : null);
        await client.query(
          `INSERT INTO backup_jobs
             (tenant_id, kind, name, scope_mode, schedule, verify_schedule, enabled, origin,
              next_run_at, verify_next_run_at)
           VALUES ($1, 'mail', $2, 'all', $3, $4, true, 'user', $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            tenantId,
            name,
            backup ? JSON.stringify(jobScheduleFromCadence(backup)) : null,
            verify ? JSON.stringify(jobScheduleFromCadence(verify)) : null,
            timer(backup),
            timer(verify),
          ],
        );
        created.push(...forJob.map((schedule) => schedule.kind));
      }
      await client.query("UPDATE tenants SET schedule_defaults_applied_at = $2 WHERE id = $1", [
        tenantId,
        now,
      ]);
      await client.query("COMMIT");
      return { applied: true, created };
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
      const jobMembers = await client.query<{
        job_id: string;
        protected_object_id: string;
        overrides: NonNullable<TenantTargets["jobMembers"]>[number]["overrides"];
      }>(
        `SELECT job_id, protected_object_id, overrides
           FROM backup_job_members
          WHERE tenant_id = $1 AND protected_object_id IS NOT NULL`,
        [tenantId],
      );
      await client.query("COMMIT");
      return {
        protectedObjects: objects.rows,
        sources: sources.rows,
        jobMembers: jobMembers.rows.map((row) => ({
          jobId: row.job_id,
          protectedObjectId: row.protected_object_id,
          overrides: row.overrides ?? {},
        })),
      };
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
      // A backup job may have taken this schedule over since it was loaded (the migration, or
      // the api): then the job plans these runs and this schedule must not.
      const live = await client.query<{ superseded_by_job_id: string | null }>(
        "SELECT superseded_by_job_id FROM schedules WHERE id = $1 FOR UPDATE",
        [schedule.id],
      );
      if (live.rows.length === 0 || live.rows[0]?.superseded_by_job_id != null) {
        await client.query("ROLLBACK");
        return { enqueued: 0, skipped: 0 };
      }
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

  // -------------------------------------------------------------------------
  // Backup jobs (mail): what is due, and enqueueing it
  // -------------------------------------------------------------------------

  /**
   * The things due for enabled mail jobs of active tenants (across tenants): a job's backups or
   * restore checks on the job's own timer, and an object whose member row carries a schedule of
   * its own, on that row's timer. A timer that was never set counts as due.
   */
  async loadDueUnits(now: Date, limit: number): Promise<JobUnit[]> {
    interface JobRecord {
      id: string;
      tenant_id: string;
      scope_mode: "all" | "selected";
      schedule: JobSchedule | null;
      verify_schedule: JobSchedule | null;
      next_run_at: Date | null;
      last_run_at: Date | null;
      verify_next_run_at: Date | null;
      verify_last_run_at: Date | null;
    }
    const jobFields = `j.id, j.tenant_id, j.scope_mode, j.schedule, j.verify_schedule,
              j.next_run_at, j.last_run_at, j.verify_next_run_at, j.verify_last_run_at`;
    const toJob = (row: JobRecord): BackupJobRow => ({
      id: row.id,
      tenantId: row.tenant_id,
      scopeMode: row.scope_mode,
      schedule: row.schedule,
      verifySchedule: row.verify_schedule,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      verifyNextRunAt: row.verify_next_run_at,
      verifyLastRunAt: row.verify_last_run_at,
    });
    const units: JobUnit[] = [];
    const jobs = await this.installation.query<JobRecord>(
      `SELECT ${jobFields}
         FROM backup_jobs j
         JOIN tenants t ON t.id = j.tenant_id
        WHERE j.kind = 'mail' AND j.enabled AND t.status = 'active'
          AND ((j.schedule IS NOT NULL AND (j.next_run_at IS NULL OR j.next_run_at <= $1))
            OR (j.verify_schedule IS NOT NULL
                AND (j.verify_next_run_at IS NULL OR j.verify_next_run_at <= $1)))
        ORDER BY j.created_at, j.id
        LIMIT $2`,
      [now, limit],
    );
    for (const record of jobs.rows) {
      const job = toJob(record);
      if (job.schedule && (job.nextRunAt === null || job.nextRunAt <= now)) {
        units.push({ level: "job", what: "backup", job });
      }
      if (job.verifySchedule && (job.verifyNextRunAt === null || job.verifyNextRunAt <= now)) {
        units.push({ level: "job", what: "verify", job });
      }
    }
    interface MemberRecord extends JobRecord {
      member_id: string;
      protected_object_id: string;
      overrides: JobMemberRow["overrides"];
      m_next_run_at: Date | null;
      m_last_run_at: Date | null;
      m_verify_next_run_at: Date | null;
      m_verify_last_run_at: Date | null;
    }
    const members = await this.installation.query<MemberRecord>(
      `SELECT ${jobFields}, m.id AS member_id, m.protected_object_id, m.overrides,
              m.next_run_at AS m_next_run_at, m.last_run_at AS m_last_run_at,
              m.verify_next_run_at AS m_verify_next_run_at,
              m.verify_last_run_at AS m_verify_last_run_at
         FROM backup_job_members m
         JOIN backup_jobs j ON j.id = m.job_id
         JOIN tenants t ON t.id = j.tenant_id
        WHERE j.kind = 'mail' AND j.enabled AND t.status = 'active'
          AND m.protected_object_id IS NOT NULL
          AND ((jsonb_typeof(m.overrides -> 'schedule') = 'object'
                AND (m.next_run_at IS NULL OR m.next_run_at <= $1))
            OR (jsonb_typeof(m.overrides -> 'verifySchedule') = 'object'
                AND (m.verify_next_run_at IS NULL OR m.verify_next_run_at <= $1)))
        ORDER BY m.created_at, m.id
        LIMIT $2`,
      [now, limit],
    );
    for (const record of members.rows) {
      const job = toJob(record);
      const member: JobMemberRow = {
        id: record.member_id,
        jobId: record.id,
        protectedObjectId: record.protected_object_id,
        overrides: record.overrides ?? {},
        nextRunAt: record.m_next_run_at,
        lastRunAt: record.m_last_run_at,
        verifyNextRunAt: record.m_verify_next_run_at,
        verifyLastRunAt: record.m_verify_last_run_at,
      };
      if (member.overrides.schedule && (member.nextRunAt === null || member.nextRunAt <= now)) {
        units.push({ level: "member", what: "backup", job, member });
      }
      if (
        member.overrides.verifySchedule &&
        (member.verifyNextRunAt === null || member.verifyNextRunAt <= now)
      ) {
        units.push({ level: "member", what: "verify", job, member });
      }
    }
    return units.slice(0, limit);
  }

  /** The timer columns of a unit: which table, which row, which pair of columns. */
  private unitTarget(unit: JobUnit): { table: string; id: string; next: string; last: string } {
    const prefix = unit.what === "backup" ? "" : "verify_";
    return unit.level === "job"
      ? {
          table: "backup_jobs",
          id: unit.job.id,
          next: `${prefix}next_run_at`,
          last: `${prefix}last_run_at`,
        }
      : {
          table: "backup_job_members",
          id: unit.member.id,
          next: `${prefix}next_run_at`,
          last: `${prefix}last_run_at`,
        };
  }

  /**
   * Enqueue the planned jobs of one unit and advance its timer, atomically. The row is locked
   * and looked at again first: a job that was switched off, deleted, or given another schedule
   * since it was loaded is left alone (the api changed it; the next tick plans from the new state).
   */
  async enqueueUnit(
    boss: PgBoss,
    unit: JobUnit,
    jobs: readonly PlannedJob[],
    nextRunAt: Date,
    loadedNextRunAt: Date | null,
    now: Date,
  ): Promise<EnqueueResult> {
    const target = this.unitTarget(unit);
    const client = await this.pool.connect();
    let enqueued = 0;
    let skipped = 0;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [unit.job.tenantId]);
      const live = await client.query<{ enabled: boolean; next_run_at: Date | null }>(
        `SELECT j.enabled, x.${target.next} AS next_run_at
           FROM ${target.table} x
           JOIN backup_jobs j ON j.id = ${target.table === "backup_jobs" ? "x.id" : "x.job_id"}
          WHERE x.id = $1
            FOR UPDATE OF x`,
        [target.id],
      );
      const row = live.rows[0];
      const same =
        row !== undefined &&
        (row.next_run_at?.getTime() ?? null) === (loadedNextRunAt?.getTime() ?? null);
      if (!row || !row.enabled || !same) {
        await client.query("ROLLBACK");
        return { enqueued: 0, skipped: 0 };
      }
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
            unit.job.tenantId,
            job.queue,
            job.protectedObjectId,
            JSON.stringify(job.payload),
            pgBossJobId,
          ],
        );
        enqueued++;
      }
      await client.query(
        `UPDATE ${target.table}
            SET ${target.last} = $2, ${target.next} = $3, updated_at = now()
          WHERE id = $1`,
        [target.id, now, nextRunAt],
      );
      await client.query("COMMIT");
      return { enqueued, skipped };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Push a unit's next run without running it (a schedule that cannot be planned). */
  async deferUnit(unit: JobUnit, nextRunAt: Date): Promise<void> {
    const target = this.unitTarget(unit);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [unit.job.tenantId]);
      await client.query(
        `UPDATE ${target.table} SET ${target.next} = $2, updated_at = now() WHERE id = $1`,
        [target.id, nextRunAt],
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
