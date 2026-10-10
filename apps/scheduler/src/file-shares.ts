// File share jobs (docs/FILESHARES.md 8.1): the scheduler decides what is due and hands one
// pg-boss job per share (or copy job) and kind to the worker. It starts no runner itself; the
// worker's dispatcher does.
//
//   file-share-backup     every member share of a due share job (members with a schedule of
//                         their own on their own timer), singleton per share
//   file-share-copy       every due copy job, singleton per job
//   file-share-retention  every share with a restore point once a day
//   file-share-check      every share with a restore point once a week (5 % of its data)
//   file-share-verify     every new good restore point with samples and no restore check yet
//   file-share-catalog    every share with a restore point not in the catalog yet
//   file-share-monitor    every minute
//
// What is due comes from the rows themselves (`next_run_at` of jobs and members, the share's
// `last_*_at` columns, the reports and restore points), so a restart or a second scheduler
// decides the same. pg-boss' singleton keys keep a job from being queued twice, and
// `singletonSeconds` spaces the retries of a share whose maintenance keeps failing.

import {
  FILE_SHARE_QUEUES,
  FILE_SHARE_QUEUE_SETTINGS,
  type FileShareBackupPayload,
  type FileShareCopyPayload,
  type FileShareQueue,
  fileShareSingletonKey,
  mailCadenceOf,
} from "@restow/core";
import type { JobSchedule } from "@restow/core";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { errorMessage, logger } from "./logger.js";
import { computeNextRunAt } from "./planning.js";

const HOUR_SECONDS = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FileShareJobCounts {
  readonly backup: number;
  readonly copy: number;
  readonly retention: number;
  readonly check: number;
  readonly verify: number;
  readonly catalog: number;
  readonly monitor: number;
}

/** The pg-boss options of the file share queues (settings shared with the worker, @restow/core). */
export const FILE_SHARE_QUEUE_OPTIONS: Record<string, PgBoss.Queue> = Object.fromEntries(
  Object.values(FILE_SHARE_QUEUE_SETTINGS).map((settings) => [settings.name, { ...settings }]),
);

/**
 * The next run of a share or copy job's schedule after `now` (interval, cron or daily, read in
 * the schedule's zone); null for a schedule that cannot be planned.
 */
export function shareNextRunAt(schedule: JobSchedule, id: string, now: Date): Date | null {
  const cadence = mailCadenceOf(schedule);
  if (!cadence) {
    return null;
  }
  try {
    return computeNextRunAt(
      {
        id,
        intervalMinutes: cadence.intervalMinutes,
        cron: cadence.cron,
        timezone: cadence.timezone,
      },
      now,
    );
  } catch {
    return null;
  }
}

interface DueJob {
  id: string;
  tenant_id: string;
  schedule: JobSchedule;
  next_run_at: Date | null;
}

interface DueMember {
  id: string;
  job_id: string;
  tenant_id: string;
  file_share_id: string;
  schedule: JobSchedule;
  next_run_at: Date | null;
}

interface DueShare {
  id: string;
  tenant_id: string;
}

export class FileShareJobPlanner {
  private lastPlanned = 0;

  constructor(
    private readonly pools: { readonly installation: Pool },
    private readonly boss: PgBoss,
    /** How often a planning pass runs; the tick loop is more frequent. */
    private readonly intervalMs = 60_000,
    private readonly retentionEveryMs = DAY_MS,
    private readonly checkEveryMs = 7 * DAY_MS,
    /** How long a job whose schedule cannot be planned is left alone. */
    private readonly deferMs = 60 * 60 * 1000,
  ) {}

  private query<T extends object>(text: string, values: unknown[] = []): Promise<T[]> {
    return this.pools.installation.query<T>(text, values).then((result) => result.rows);
  }

  /** The share and copy jobs due now, and the members with a schedule of their own. */
  async dueJobs(now: Date): Promise<{ share: DueJob[]; copy: DueJob[]; members: DueMember[] }> {
    const jobs = (kind: "share" | "copy") =>
      this.query<DueJob>(
        `SELECT j.id, j.tenant_id, j.schedule, j.next_run_at
           FROM backup_jobs j
           JOIN tenants t ON t.id = j.tenant_id
          WHERE j.kind = $1 AND j.enabled AND t.status = 'active'
            AND jsonb_typeof(j.schedule) = 'object'
            AND (j.next_run_at IS NULL OR j.next_run_at <= $2)
          ORDER BY j.next_run_at NULLS FIRST, j.id
          LIMIT 200`,
        [kind, now],
      );
    const members = await this.query<DueMember>(
      `SELECT m.id, m.job_id, m.tenant_id, m.file_share_id, m.overrides -> 'schedule' AS schedule,
              m.next_run_at
         FROM backup_job_members m
         JOIN backup_jobs j ON j.id = m.job_id
         JOIN tenants t ON t.id = j.tenant_id
         JOIN file_shares s ON s.id = m.file_share_id
        WHERE j.kind = 'share' AND j.enabled AND t.status = 'active' AND s.retired_at IS NULL
          AND jsonb_typeof(m.overrides -> 'schedule') = 'object'
          AND (m.next_run_at IS NULL OR m.next_run_at <= $1)
        ORDER BY m.next_run_at NULLS FIRST, m.id
        LIMIT 500`,
      [now],
    );
    return { share: await jobs("share"), copy: await jobs("copy"), members };
  }

  /** The maintenance that is due, from the share rows themselves. */
  async dueMaintenance(now: Date): Promise<{
    retention: DueShare[];
    check: DueShare[];
    verify: DueShare[];
    catalog: DueShare[];
  }> {
    const base = `
      FROM file_shares s
      JOIN tenants t ON t.id = s.tenant_id
     WHERE t.status = 'active'
       AND s.last_snapshot_id IS NOT NULL`;
    const retention = await this.query<DueShare>(
      `SELECT s.id, s.tenant_id ${base}
          AND s.retired_at IS NULL
          AND (s.last_retention_at IS NULL OR s.last_retention_at < $1)
        ORDER BY s.last_retention_at NULLS FIRST LIMIT 200`,
      [new Date(now.getTime() - this.retentionEveryMs)],
    );
    const check = await this.query<DueShare>(
      `SELECT s.id, s.tenant_id ${base}
          AND (s.last_check_at IS NULL OR s.last_check_at < $1)
        ORDER BY s.last_check_at NULLS FIRST LIMIT 200`,
      [new Date(now.getTime() - this.checkEveryMs)],
    );
    const verify = await this.query<DueShare>(
      `SELECT s.id, s.tenant_id ${base}
          AND EXISTS (SELECT 1 FROM file_share_snapshots p
                       JOIN file_share_samples x
                         ON x.file_share_id = p.file_share_id AND x.snapshot_id = p.restic_snapshot_id
                      WHERE p.id = s.last_snapshot_id AND p.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM file_share_snapshots p
                           JOIN file_share_reports r
                             ON r.file_share_id = p.file_share_id AND r.kind = 'restore_test'
                            AND r.snapshot_id = p.restic_snapshot_id
                          WHERE p.id = s.last_snapshot_id)
        ORDER BY s.last_success_at LIMIT 200`,
    );
    const catalog = await this.query<DueShare>(
      `SELECT s.id, s.tenant_id ${base}
          AND EXISTS (SELECT 1 FROM file_share_snapshots p
                       WHERE p.file_share_id = s.id AND p.status = 'active'
                         AND p.cataloged_at IS NULL)
        ORDER BY s.last_success_at LIMIT 200`,
    );
    return { retention, check, verify, catalog };
  }

  private async send(
    queue: FileShareQueue,
    data: object,
    key: string,
    spacingSeconds?: number,
  ): Promise<boolean> {
    const id = await this.boss.send(queue, data, {
      singletonKey: fileShareSingletonKey(queue, key),
      ...(spacingSeconds ? { singletonSeconds: spacingSeconds } : {}),
    });
    return id !== null;
  }

  /** Advance a timer, unless someone changed it since it was read (the api, another leader). */
  private async advance(
    table: "backup_jobs" | "backup_job_members",
    id: string,
    seen: Date | null,
    next: Date,
    now: Date,
  ): Promise<boolean> {
    const result = await this.pools.installation.query(
      `UPDATE ${table} SET next_run_at = $2, last_run_at = $3, updated_at = $3
        WHERE id = $1 AND next_run_at IS NOT DISTINCT FROM $4`,
      [id, next, now, seen],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async planShareJob(job: DueJob, now: Date): Promise<number> {
    const next = shareNextRunAt(job.schedule, job.id, now);
    if (
      !(await this.advance(
        "backup_jobs",
        job.id,
        job.next_run_at,
        next ?? new Date(now.getTime() + this.deferMs),
        now,
      ))
    ) {
      return 0;
    }
    if (!next) {
      logger.error("file share job cannot be planned, deferring", { backupJobId: job.id });
      return 0;
    }
    const shares = await this.query<{ file_share_id: string }>(
      `SELECT m.file_share_id
         FROM backup_job_members m
         JOIN file_shares s ON s.id = m.file_share_id
        WHERE m.job_id = $1 AND s.retired_at IS NULL
          AND jsonb_typeof(m.overrides -> 'schedule') IS DISTINCT FROM 'object'`,
      [job.id],
    );
    const minutes = mailCadenceOf(job.schedule)?.intervalMinutes ?? null;
    let sent = 0;
    for (const { file_share_id } of shares) {
      const payload: FileShareBackupPayload = {
        tenantId: job.tenant_id,
        fileShareId: file_share_id,
        backupJobId: job.id,
        trigger: "schedule",
        intervalMinutes: minutes,
      };
      if (await this.send(FILE_SHARE_QUEUES.backup, payload, file_share_id)) sent++;
    }
    return sent;
  }

  private async planMember(member: DueMember, now: Date): Promise<number> {
    const next = shareNextRunAt(member.schedule, member.id, now);
    if (
      !(await this.advance(
        "backup_job_members",
        member.id,
        member.next_run_at,
        next ?? new Date(now.getTime() + this.deferMs),
        now,
      ))
    ) {
      return 0;
    }
    if (!next) {
      return 0;
    }
    const payload: FileShareBackupPayload = {
      tenantId: member.tenant_id,
      fileShareId: member.file_share_id,
      backupJobId: member.job_id,
      trigger: "schedule",
      intervalMinutes: mailCadenceOf(member.schedule)?.intervalMinutes ?? null,
    };
    return (await this.send(FILE_SHARE_QUEUES.backup, payload, member.file_share_id)) ? 1 : 0;
  }

  private async planCopyJob(job: DueJob, now: Date): Promise<number> {
    const next = shareNextRunAt(job.schedule, job.id, now);
    if (
      !(await this.advance(
        "backup_jobs",
        job.id,
        job.next_run_at,
        next ?? new Date(now.getTime() + this.deferMs),
        now,
      ))
    ) {
      return 0;
    }
    if (!next) {
      return 0;
    }
    const payload: FileShareCopyPayload = { tenantId: job.tenant_id, backupJobId: job.id };
    return (await this.send(FILE_SHARE_QUEUES.copy, payload, job.id)) ? 1 : 0;
  }

  /** One planning pass; it does nothing if the last one was less than `intervalMs` ago. */
  async plan(now: Date): Promise<FileShareJobCounts | null> {
    if (now.getTime() - this.lastPlanned < this.intervalMs) {
      return null;
    }
    this.lastPlanned = now.getTime();
    const counts = {
      backup: 0,
      copy: 0,
      retention: 0,
      check: 0,
      verify: 0,
      catalog: 0,
      monitor: 0,
    };
    try {
      const due = await this.dueJobs(now);
      for (const job of due.share) {
        counts.backup += await this.planShareJob(job, now);
      }
      for (const member of due.members) {
        counts.backup += await this.planMember(member, now);
      }
      for (const job of due.copy) {
        counts.copy += await this.planCopyJob(job, now);
      }
      const maintenance = await this.dueMaintenance(now);
      const payload = (row: DueShare) => ({ tenantId: row.tenant_id, fileShareId: row.id });
      for (const row of maintenance.retention) {
        if (await this.send(FILE_SHARE_QUEUES.retention, payload(row), row.id, HOUR_SECONDS))
          counts.retention++;
      }
      for (const row of maintenance.check) {
        if (await this.send(FILE_SHARE_QUEUES.check, payload(row), row.id, HOUR_SECONDS))
          counts.check++;
      }
      for (const row of maintenance.verify) {
        if (await this.send(FILE_SHARE_QUEUES.verify, payload(row), row.id, HOUR_SECONDS))
          counts.verify++;
      }
      for (const row of maintenance.catalog) {
        if (await this.send(FILE_SHARE_QUEUES.catalog, payload(row), row.id, HOUR_SECONDS))
          counts.catalog++;
      }
      const monitor = await this.boss.send(
        FILE_SHARE_QUEUES.monitor,
        {},
        { singletonKey: FILE_SHARE_QUEUES.monitor, singletonSeconds: 50 },
      );
      if (monitor !== null) counts.monitor++;
    } catch (error) {
      logger.error("planning file share jobs failed", { err: errorMessage(error) });
    }
    return counts;
  }
}
