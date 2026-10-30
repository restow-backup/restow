import { type Database, pveGuests, pveJobs, pveRuns } from "@restow/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { activeRuns } from "../history/read.js";
import { type PveRunningDto, RUNNING_LIMIT, type RunningNowDto } from "./dto.js";

/**
 * What runs right now in one tenant: its mail, machine and file share runs (the History
 * shapes), its Proxmox VE runs and the next planned start. Every read goes through the
 * tenant's pinned transaction, so Row Level Security keeps another tenant's runs out.
 */

type PveRunningRow = {
  id: string;
  kind: PveRunningDto["kind"];
  startedAt: Date;
  cancelRequestedAt: Date | null;
  progress: PveRunningDto["progress"];
  guestId: string;
  vmid: number;
  guestName: string | null;
  guestKind: PveRunningDto["guest"]["kind"];
  jobName: string | null;
};

/** The shape of a Proxmox VE run row; pure, tested without a database. */
export function pveRunning(row: PveRunningRow): PveRunningDto {
  return {
    id: row.id,
    kind: row.kind,
    guest: { id: row.guestId, vmid: row.vmid, name: row.guestName, kind: row.guestKind },
    jobName: row.jobName,
    startedAt: row.startedAt.toISOString(),
    cancelling: row.cancelRequestedAt !== null,
    progress: row.progress
      ? {
          bytesDone: row.progress.bytesDone,
          bytesTotal: row.progress.bytesTotal,
          bytesUploaded: row.progress.bytesUploaded,
          bytesPerSecond: row.progress.bytesPerSecond,
          at: row.progress.at,
        }
      : null,
  };
}

/**
 * The runs of Proxmox VE guests that go on now, newest first (one indexed read of
 * `pve_runs_status_idx`, the guests and jobs joined for their names). The same read the live
 * channel repeats every few seconds, so it touches nothing else.
 */
export async function pveRunningRuns(
  tx: Transaction,
  tenantId: string,
  limit: number = RUNNING_LIMIT,
): Promise<PveRunningDto[]> {
  const rows = await tx
    .select({
      id: pveRuns.id,
      kind: pveRuns.kind,
      startedAt: pveRuns.startedAt,
      cancelRequestedAt: pveRuns.cancelRequestedAt,
      progress: pveRuns.progress,
      guestId: pveGuests.id,
      vmid: pveGuests.vmid,
      guestName: pveGuests.name,
      guestKind: pveGuests.kind,
      jobName: pveJobs.name,
    })
    .from(pveRuns)
    .innerJoin(pveGuests, eq(pveGuests.id, pveRuns.guestId))
    .leftJoin(pveJobs, eq(pveJobs.id, pveGuests.jobId))
    .where(and(eq(pveRuns.tenantId, tenantId), eq(pveRuns.status, "running")))
    .orderBy(desc(pveRuns.startedAt), desc(pveRuns.id))
    .limit(limit);
  return rows.map(pveRunning);
}

interface PlannedRow extends Record<string, unknown> {
  at: Date | string | null;
}

/**
 * The earliest planned start of an enabled job: a mail, file share or copy job's own time, the
 * mailboxes with a schedule of their own, the machines in an enabled machine job, and the
 * Proxmox VE jobs. The same sources the Jobs overview of all tenants takes its "next run" from
 * (features/tenant-jobs), without counting anything else on the way.
 */
export async function nextPlannedRun(tx: Transaction, tenantId: string): Promise<string | null> {
  const result = await tx.execute<PlannedRow>(sql`
    SELECT min(planned.at) AS at FROM (
      SELECT j.next_run_at AS at FROM backup_jobs j
       WHERE j.tenant_id = ${tenantId} AND j.enabled AND j.kind IN ('mail', 'share', 'copy')
      UNION ALL
      SELECT m.next_run_at FROM backup_job_members m
        JOIN backup_jobs j ON j.id = m.job_id
       WHERE j.tenant_id = ${tenantId} AND j.enabled AND j.kind = 'mail'
         AND m.overrides->'schedule' IS NOT NULL
      UNION ALL
      SELECT e.next_run_at FROM endpoints e
        JOIN backup_job_members m ON m.endpoint_id = e.id
        JOIN backup_jobs j ON j.id = m.job_id
       WHERE e.tenant_id = ${tenantId} AND e.status = 'active'
         AND j.enabled AND j.kind = 'endpoint'
      UNION ALL
      SELECT p.next_run_at FROM pve_jobs p
       WHERE p.tenant_id = ${tenantId} AND p.enabled
    ) planned
    WHERE planned.at IS NOT NULL`);
  const at = result.rows[0]?.at;
  return at ? new Date(at).toISOString() : null;
}

/** What runs in one tenant, in the transaction that is pinned to it. */
export async function readRunning(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<RunningNowDto> {
  const active = await activeRuns(tx, tenantId, RUNNING_LIMIT);
  // One row more than listed says whether any were cut off.
  const pve = await pveRunningRuns(tx, tenantId, RUNNING_LIMIT + 1);
  return {
    generatedAt: now.toISOString(),
    runs: active.runs,
    pve: pve.slice(0, RUNNING_LIMIT),
    truncated: active.truncated || pve.length > RUNNING_LIMIT,
    nextRunAt: await nextPlannedRun(tx, tenantId),
  };
}

/** What runs in one tenant now, and its next planned start (the dashboard's widget). */
export async function loadRunning(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<RunningNowDto> {
  return withTenantTx(db, tenantId, (tx) => readRunning(tx, tenantId, now));
}
