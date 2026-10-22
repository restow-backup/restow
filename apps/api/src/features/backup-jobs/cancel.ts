import {
  backupJobMembers,
  type Database,
  endpointRuns,
  endpoints,
  endpointTasks,
  fileShareRuns,
  jobs,
} from "@restow/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS } from "../endpoints/audit.js";
import { cancelQueuedJob } from "../jobs/queue.js";
import { loadJob } from "./read.js";
import { BACKUP_JOB_AUDIT_ACTIONS, type JobActor } from "./service-types.js";

/**
 * "Stop" of a backup job (0.4.5): every backup of the job that waits or runs, in one request,
 * whatever the number of its objects or machines. The same rules as stopping one run (0.4.2):
 *
 *   mail     a queued backup ends `cancelled` at once; a running one is marked `cancelled` and the
 *            worker stops at its next halt point (between folders and pages), keeping what it
 *            stored so far (features/jobs `cancelJob`).
 *   endpoint a pending "back up now" of a machine in the job is withdrawn, a delivered one gets a
 *            cancel request, a running backup gets one too: the agent stops restic with its next
 *            heartbeat (features/endpoints `cancelEndpointBackup`).
 *   share,   a queued run of the job ends `cancelled`, a starting or running one gets a cancel
 *   copy     request the runner acts on (features/file-shares `cancelRun`).
 *
 * Set-based: a few statements per kind, never one per object. Audited once on the job (with the
 * counts), and per machine like a machine's own "Stop" so its audit trail stays complete.
 */

export const BACKUP_JOB_CANCEL_PROBLEM = "urn:restow:problem:backup-job-nothing-to-cancel";

export interface BackupJobCancelResult {
  /** Backups withdrawn before they started. */
  withdrawn: number;
  /** Running backups (or ones a machine may be starting) asked to stop. */
  stopping: number;
}

/** POST /backup-jobs/:id/cancel. */
export async function cancelBackupJob(
  database: Database,
  tenantId: string,
  id: string,
  actor: JobActor,
  now: Date = new Date(),
): Promise<BackupJobCancelResult> {
  const { result, boss } = await withTenantTx(database, tenantId, async (tx) => {
    const job = await loadJob(tx, tenantId, id);
    let outcome: { result: BackupJobCancelResult; boss: string[] };
    if (job.kind === "mail") {
      outcome = await cancelMail(tx, tenantId, id, now);
    } else if (job.kind === "endpoint") {
      outcome = { result: await cancelMachines(tx, tenantId, id, job.name, actor, now), boss: [] };
    } else {
      outcome = { result: await cancelShareRuns(tx, tenantId, id, now), boss: [] };
    }
    if (outcome.result.withdrawn + outcome.result.stopping === 0) {
      throw new ProblemError(409, "Nothing to cancel", {
        type: BACKUP_JOB_CANCEL_PROBLEM,
        detail: "No backup of this job is queued or running.",
      });
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      ip: actor.ip,
      action: BACKUP_JOB_AUDIT_ACTIONS.runCancelled,
      target: id,
      targetType: "backup_job",
      details: { name: job.name, kind: job.kind, ...outcome.result },
    });
    return outcome;
  });
  // Best effort, like a single run's cancel: the rows say cancelled already, and the worker
  // checks that before it starts a delivered job.
  await Promise.all(boss.map((bossId) => cancelQueuedJob("backup", bossId).catch(() => undefined)));
  return result;
}

/** The mail backups the job queued (its "Run now" and the scheduler name the job in the payload). */
async function cancelMail(
  tx: Transaction,
  tenantId: string,
  id: string,
  now: Date,
): Promise<{ result: BackupJobCancelResult; boss: string[] }> {
  const ofJob = and(
    eq(jobs.tenantId, tenantId),
    eq(jobs.queue, "backup"),
    sql`${jobs.payload}->>'backupJobId' = ${id}`,
  );
  const withdrawn = await tx
    .update(jobs)
    .set({ status: "cancelled", completedAt: now, cursor: null })
    .where(and(ofJob, eq(jobs.status, "queued")))
    .returning({ id: jobs.id, pgBossJobId: jobs.pgBossJobId });
  // A running backup stops at its next halt point and keeps what it stored.
  const stopping = await tx
    .update(jobs)
    .set({ status: "cancelled" })
    .where(and(ofJob, eq(jobs.status, "active")))
    .returning({ id: jobs.id });
  return {
    result: { withdrawn: withdrawn.length, stopping: stopping.length },
    boss: withdrawn.flatMap((row) => (row.pgBossJobId ? [row.pgBossJobId] : [])),
  };
}

/** The machines of the job: their queued "back up now" and their running backups. */
async function cancelMachines(
  tx: Transaction,
  tenantId: string,
  id: string,
  jobName: string,
  actor: JobActor,
  now: Date,
): Promise<BackupJobCancelResult> {
  const machines = sql`(SELECT ${backupJobMembers.endpointId} FROM ${backupJobMembers}
    WHERE ${backupJobMembers.jobId} = ${id} AND ${backupJobMembers.endpointId} IS NOT NULL)`;
  const withdrawn = await tx
    .update(endpointTasks)
    .set({
      status: "cancelled",
      finishedAt: now,
      cancelRequestedAt: now,
      cancelledBy: actor.label,
      errorMessage: `Cancelled by ${actor.label} before it started.`,
    })
    .where(
      and(
        eq(endpointTasks.tenantId, tenantId),
        sql`${endpointTasks.endpointId} IN ${machines}`,
        eq(endpointTasks.kind, "backup_now"),
        eq(endpointTasks.status, "pending"),
      ),
    )
    .returning({ endpointId: endpointTasks.endpointId });
  const delivered = await tx
    .update(endpointTasks)
    .set({ cancelRequestedAt: now, cancelledBy: actor.label })
    .where(
      and(
        eq(endpointTasks.tenantId, tenantId),
        sql`${endpointTasks.endpointId} IN ${machines}`,
        eq(endpointTasks.kind, "backup_now"),
        eq(endpointTasks.status, "delivered"),
        isNull(endpointTasks.cancelRequestedAt),
        sql`NOT EXISTS (SELECT 1 FROM endpoint_runs r WHERE r.task_id = ${endpointTasks.id} AND r.status = 'running')`,
      ),
    )
    .returning({ endpointId: endpointTasks.endpointId });
  // Asking again keeps the first request (and who made it).
  const runs = await tx
    .update(endpointRuns)
    .set({
      cancelRequestedAt: sql`coalesce(${endpointRuns.cancelRequestedAt}, ${now})`,
      cancelledBy: sql`coalesce(${endpointRuns.cancelledBy}, ${actor.label})`,
    })
    .where(
      and(
        eq(endpointRuns.tenantId, tenantId),
        sql`${endpointRuns.endpointId} IN ${machines}`,
        eq(endpointRuns.kind, "backup"),
        eq(endpointRuns.status, "running"),
      ),
    )
    .returning({
      id: endpointRuns.id,
      endpointId: endpointRuns.endpointId,
      taskId: endpointRuns.taskId,
    });
  const runTasks = runs.flatMap((run) => (run.taskId ? [run.taskId] : []));
  if (runTasks.length > 0) {
    await tx
      .update(endpointTasks)
      .set({ cancelRequestedAt: now, cancelledBy: actor.label })
      .where(
        and(
          inArray(endpointTasks.id, runTasks),
          inArray(endpointTasks.status, ["pending", "delivered"]),
          isNull(endpointTasks.cancelRequestedAt),
        ),
      );
  }
  // Each machine's audit trail says it was stopped, as its own "Stop" would.
  const perMachine = new Map<string, BackupJobCancelResult>();
  const count = (endpointId: string, key: keyof BackupJobCancelResult) => {
    const entry = perMachine.get(endpointId) ?? { withdrawn: 0, stopping: 0 };
    entry[key]++;
    perMachine.set(endpointId, entry);
  };
  for (const row of withdrawn) count(row.endpointId, "withdrawn");
  for (const row of [...delivered, ...runs]) count(row.endpointId, "stopping");
  if (perMachine.size > 0) {
    const names = await tx
      .select({ id: endpoints.id, hostname: endpoints.hostname })
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, [...perMachine.keys()])));
    const hostOf = new Map(names.map((row) => [row.id, row.hostname]));
    for (const [endpointId, counts] of perMachine) {
      await auditEndpoint(tx, {
        tenantId,
        actor,
        action: ENDPOINT_AUDIT_ACTIONS.backupCancelled,
        endpointId,
        details: {
          hostname: hostOf.get(endpointId) ?? null,
          ...counts,
          via: { job: { id, name: jobName } },
        },
      });
    }
  }
  return { withdrawn: withdrawn.length, stopping: delivered.length + runs.length };
}

/** The runs of a share or copy job (`file_share_runs.backup_job_id`). */
async function cancelShareRuns(
  tx: Transaction,
  tenantId: string,
  id: string,
  now: Date,
): Promise<BackupJobCancelResult> {
  const withdrawn = await tx
    .update(fileShareRuns)
    .set({
      status: "cancelled",
      cancelRequestedAt: now,
      finishedAt: now,
      finishProcessedAt: now,
      params: sql`coalesce(${fileShareRuns.params}, '{}'::jsonb) || '{"note":"Cancelled before it started"}'::jsonb`,
    })
    .where(
      and(
        eq(fileShareRuns.tenantId, tenantId),
        eq(fileShareRuns.backupJobId, id),
        eq(fileShareRuns.status, "queued"),
      ),
    )
    .returning({ id: fileShareRuns.id });
  const stopping = await tx
    .update(fileShareRuns)
    .set({ cancelRequestedAt: sql`coalesce(${fileShareRuns.cancelRequestedAt}, ${now})` })
    .where(
      and(
        eq(fileShareRuns.tenantId, tenantId),
        eq(fileShareRuns.backupJobId, id),
        inArray(fileShareRuns.status, ["starting", "running"]),
      ),
    )
    .returning({ id: fileShareRuns.id });
  return { withdrawn: withdrawn.length, stopping: stopping.length };
}
