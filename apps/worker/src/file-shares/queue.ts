/**
 * Turning due jobs into queued runs (docs/FILESHARES.md 8.2). The scheduler sends
 * `file-share-backup` for every member share of a due share job and `file-share-copy` for every
 * due copy job; these handlers insert the `queued` run the dispatcher then starts. Manual runs
 * and restores are inserted by the api directly.
 *
 *   - backup: one queued backup per share at most (a partial unique index). A share whose
 *     queued backup is still waiting (the previous run is still running) gets no second one; a
 *     scheduled tick that finds it so is recorded as skipped, so the run list says why.
 *   - copy: a restore run with `trigger = 'copy'`, the job's target as the mount it holds, the
 *     source as the repository it reads, unless a run of the job is queued or running. The
 *     restore point is picked when the run starts (4.10).
 */
import type { FileShareBackupPayload, FileShareCopyPayload } from "@restow/core";
import { backupJobMembers, backupJobs, fileShareRuns, fileShares, tenants } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import type { FileShareDeps } from "./common.js";

export const SKIPPED_NOTE = "Skipped: the previous run was still running";

export type QueueOutcome = "queued" | "already_queued" | "skipped" | "not_due";

async function tenantActive(deps: FileShareDeps, tenantId: string): Promise<boolean> {
  const [row] = await deps.providerDb
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.status === "active";
}

/** `file-share-backup`: queue a backup of one share. */
export async function queueShareBackup(
  deps: FileShareDeps,
  payload: FileShareBackupPayload,
): Promise<QueueOutcome> {
  if (!(await tenantActive(deps, payload.tenantId))) {
    return "not_due";
  }
  const now = deps.runtime.now();
  return withTenantTx(deps.db, payload.tenantId, async (tx) => {
    const [share] = await tx
      .select({ id: fileShares.id, retiredAt: fileShares.retiredAt })
      .from(fileShares)
      .where(eq(fileShares.id, payload.fileShareId))
      .for("update");
    if (!share || share.retiredAt) {
      return "not_due";
    }
    if (payload.backupJobId) {
      // The job may have been switched off or the share taken out since it was planned.
      const [member] = await tx
        .select({ enabled: backupJobs.enabled })
        .from(backupJobMembers)
        .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
        .where(
          and(
            eq(backupJobMembers.fileShareId, share.id),
            eq(backupJobMembers.jobId, payload.backupJobId),
            eq(backupJobs.kind, "share"),
          ),
        )
        .limit(1);
      if (!member?.enabled) {
        return "not_due";
      }
    }
    const [waiting] = await tx
      .select({ id: fileShareRuns.id })
      .from(fileShareRuns)
      .where(
        and(
          eq(fileShareRuns.fileShareId, share.id),
          eq(fileShareRuns.kind, "backup"),
          eq(fileShareRuns.status, "queued"),
        ),
      )
      .limit(1);
    if (waiting) {
      if (payload.trigger !== "schedule") {
        return "already_queued";
      }
      await tx.insert(fileShareRuns).values({
        tenantId: payload.tenantId,
        fileShareId: share.id,
        lockShareId: share.id,
        kind: "backup",
        trigger: "schedule",
        status: "cancelled",
        backupJobId: payload.backupJobId,
        params: { note: SKIPPED_NOTE },
        queuedAt: now,
        finishedAt: now,
        finishProcessedAt: now,
      });
      return "skipped";
    }
    await tx.insert(fileShareRuns).values({
      tenantId: payload.tenantId,
      fileShareId: share.id,
      lockShareId: share.id,
      kind: "backup",
      trigger: payload.trigger,
      status: "queued",
      backupJobId: payload.backupJobId,
      params: {},
      queuedAt: now,
    });
    return "queued";
  });
}

/** `file-share-copy`: queue a run of one copy job. */
export async function queueShareCopy(
  deps: FileShareDeps,
  payload: FileShareCopyPayload,
): Promise<QueueOutcome> {
  if (!(await tenantActive(deps, payload.tenantId))) {
    return "not_due";
  }
  const now = deps.runtime.now();
  return withTenantTx(deps.db, payload.tenantId, async (tx) => {
    const [job] = await tx
      .select()
      .from(backupJobs)
      .where(and(eq(backupJobs.id, payload.backupJobId), eq(backupJobs.kind, "copy")))
      .for("update");
    if (!job || !job.enabled || !job.sourceFileShareId || !job.targetFileShareId) {
      return "not_due";
    }
    const shares = await tx
      .select({ id: fileShares.id, retiredAt: fileShares.retiredAt })
      .from(fileShares)
      .where(inArray(fileShares.id, [job.sourceFileShareId, job.targetFileShareId]));
    if (shares.length !== 2 || shares.some((share) => share.retiredAt)) {
      return "not_due";
    }
    const [open] = await tx
      .select({ id: fileShareRuns.id })
      .from(fileShareRuns)
      .where(
        and(
          eq(fileShareRuns.backupJobId, job.id),
          inArray(fileShareRuns.status, ["queued", "starting", "running"]),
        ),
      )
      .limit(1);
    if (open) {
      return "already_queued";
    }
    await tx.insert(fileShareRuns).values({
      tenantId: payload.tenantId,
      fileShareId: job.sourceFileShareId,
      lockShareId: job.targetFileShareId,
      targetShareId: job.targetFileShareId,
      kind: "restore",
      trigger: "copy",
      status: "queued",
      backupJobId: job.id,
      params: {
        mode: job.settings.mode ?? "overwrite",
        targetFolder: job.settings.targetFolder ?? "",
        ...(payload.force ? { force: true } : {}),
      },
      queuedAt: now,
    });
    return "queued";
  });
}
