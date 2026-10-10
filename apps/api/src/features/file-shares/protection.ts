import {
  type ShareProtectionJob,
  type ShareProtectionMember,
  type ShareReadinessReport,
  shareJobOf,
  shareProtected,
  shareProtectedSince,
  shareReadiness,
  shareStaleBackupHours,
  shareVerifyOverdue,
  shareWarningCauses,
} from "@restow/core";
import {
  type FileShare,
  type FileShareRun,
  backupJobMembers,
  backupJobs,
  fileShareReports,
  fileShareRuns,
  fileShareSnapshots,
  fileShares,
  warningAcknowledgements,
} from "@restow/db";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";

/**
 * File shares in the overviews (docs/FILESHARES.md section 13): the SQL side of the one rule of
 * @restow/core `file-shares/protection.ts`, the way features/pve/protection.ts mirrors the PVE
 * rule. The share list and page read a share's standing from here; the dashboard, statistics and
 * History (Phase D) read it from the same place, so they never disagree.
 *
 *   - Protected: not retired and a member of an enabled share job. A share in no enabled job
 *     counts as "in no backup job".
 *   - Readiness: the restore check of the newest restore point (8.4).
 *   - Failed: the newest finished backup run of a protected share failed.
 *   - Warnings: the newest run ended with warnings and no acknowledgement covers its causes.
 *   - Overdue: no successful backup for longer than the enabled job's schedule allows.
 *
 * Copy jobs are never protection. Every read runs in the tenant's pinned transaction.
 */

export type ShareReadinessState = "green" | "yellow" | "red" | "unverified" | "no_backup";

/** How a share stands, worst first. */
export type ShareStanding =
  | "retired"
  | "failed"
  | "running"
  | "overdue"
  | "warning"
  | "no_job"
  | "no_backup"
  | "ok";

export interface ShareFact {
  share: FileShare;
  job: { id: string; name: string; enabled: boolean } | null;
  /** The member row's include folders (empty: everything). */
  includes: string[];
  protected: boolean;
  readiness: { state: ShareReadinessState; checkedAt: Date | null; overdue: boolean };
  /** The newest finished backup run. */
  lastBackupRun: Pick<
    FileShareRun,
    "id" | "status" | "finishedAt" | "failure" | "stats" | "errorMessage"
  > | null;
  /** A run that holds the share's mount or waits for it (backup of it, restore into it). */
  activeRun: Pick<
    FileShareRun,
    "id" | "kind" | "status" | "progress" | "startedAt" | "queuedAt" | "fileShareId" | "lockShareId"
  > | null;
  failed: boolean;
  /** The newest backup ended with warnings that no acknowledgement covers. */
  warnings: boolean;
  overdue: boolean;
  staleAfterHours: number;
  restorePoints: number;
  standing: ShareStanding;
}

export interface ShareCounts {
  total: number;
  protected: number;
  withoutJob: number;
  failed: number;
  warnings: number;
  lastSuccessAt: string | null;
}

const ACTIVE = ["queued", "starting", "running"] as const;

export async function loadShareFacts(
  tx: Transaction,
  tenantId: string,
  now: Date,
  options: { shareIds?: readonly string[] } = {},
): Promise<ShareFact[]> {
  const shareFilter = options.shareIds
    ? and(eq(fileShares.tenantId, tenantId), inArray(fileShares.id, [...options.shareIds]))
    : eq(fileShares.tenantId, tenantId);
  if (options.shareIds && options.shareIds.length === 0) {
    return [];
  }
  const shares = await tx.select().from(fileShares).where(shareFilter).orderBy(fileShares.name);
  if (shares.length === 0) {
    return [];
  }
  const ids = shares.map((share) => share.id);
  const jobs = await tx
    .select()
    .from(backupJobs)
    .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.kind, "share")));
  const members = await tx
    .select({
      jobId: backupJobMembers.jobId,
      fileShareId: backupJobMembers.fileShareId,
      overrides: backupJobMembers.overrides,
    })
    .from(backupJobMembers)
    .where(
      and(eq(backupJobMembers.tenantId, tenantId), inArray(backupJobMembers.fileShareId, ids)),
    );
  const lastRuns = await tx
    .selectDistinctOn([fileShareRuns.fileShareId], {
      id: fileShareRuns.id,
      fileShareId: fileShareRuns.fileShareId,
      status: fileShareRuns.status,
      finishedAt: fileShareRuns.finishedAt,
      failure: fileShareRuns.failure,
      stats: fileShareRuns.stats,
      errorMessage: fileShareRuns.errorMessage,
    })
    .from(fileShareRuns)
    .where(
      and(
        eq(fileShareRuns.tenantId, tenantId),
        inArray(fileShareRuns.fileShareId, ids),
        eq(fileShareRuns.kind, "backup"),
        inArray(fileShareRuns.status, ["succeeded", "warning", "failed"]),
        isNotNull(fileShareRuns.finishedAt),
      ),
    )
    .orderBy(fileShareRuns.fileShareId, desc(fileShareRuns.finishedAt));
  const active = await tx
    .select({
      id: fileShareRuns.id,
      kind: fileShareRuns.kind,
      status: fileShareRuns.status,
      progress: fileShareRuns.progress,
      startedAt: fileShareRuns.startedAt,
      queuedAt: fileShareRuns.queuedAt,
      fileShareId: fileShareRuns.fileShareId,
      lockShareId: fileShareRuns.lockShareId,
    })
    .from(fileShareRuns)
    .where(
      and(
        eq(fileShareRuns.tenantId, tenantId),
        inArray(fileShareRuns.lockShareId, ids),
        inArray(fileShareRuns.status, [...ACTIVE]),
      ),
    )
    .orderBy(desc(fileShareRuns.queuedAt));
  const latestSnapshots = await tx
    .select({
      id: fileShareSnapshots.id,
      fileShareId: fileShareSnapshots.fileShareId,
      resticSnapshotId: fileShareSnapshots.resticSnapshotId,
      runId: fileShareSnapshots.runId,
    })
    .from(fileShareSnapshots)
    .innerJoin(fileShares, eq(fileShares.lastSnapshotId, fileShareSnapshots.id))
    .where(
      and(eq(fileShareSnapshots.tenantId, tenantId), inArray(fileShareSnapshots.fileShareId, ids)),
    );
  const reports = await tx
    .selectDistinctOn(
      [fileShareReports.fileShareId, fileShareReports.kind, fileShareReports.snapshotId],
      {
        fileShareId: fileShareReports.fileShareId,
        kind: fileShareReports.kind,
        snapshotId: fileShareReports.snapshotId,
        readiness: fileShareReports.readiness,
        checkedAt: fileShareReports.checkedAt,
      },
    )
    .from(fileShareReports)
    .where(
      and(
        eq(fileShareReports.tenantId, tenantId),
        inArray(fileShareReports.fileShareId, ids),
        inArray(fileShareReports.kind, ["restore_test", "repository_check"]),
      ),
    )
    .orderBy(
      fileShareReports.fileShareId,
      fileShareReports.kind,
      fileShareReports.snapshotId,
      desc(fileShareReports.checkedAt),
    );
  const pointCounts = await tx
    .select({ fileShareId: fileShareSnapshots.fileShareId, n: count() })
    .from(fileShareSnapshots)
    .where(
      and(
        eq(fileShareSnapshots.tenantId, tenantId),
        inArray(fileShareSnapshots.fileShareId, ids),
        eq(fileShareSnapshots.status, "active"),
      ),
    )
    .groupBy(fileShareSnapshots.fileShareId);
  const acknowledgements = await tx
    .select({
      fileShareId: warningAcknowledgements.fileShareId,
      causes: warningAcknowledgements.causes,
      runId: warningAcknowledgements.runId,
    })
    .from(warningAcknowledgements)
    .where(
      and(
        eq(warningAcknowledgements.tenantId, tenantId),
        inArray(warningAcknowledgements.fileShareId, ids),
      ),
    );

  const protectionJobs: ShareProtectionJob[] = jobs.map((job) => ({
    id: job.id,
    kind: job.kind,
    enabled: job.enabled,
    schedule: job.schedule,
    createdAt: job.createdAt,
  }));
  const protectionMembers: ShareProtectionMember[] = members.map((member) => ({
    jobId: member.jobId,
    fileShareId: member.fileShareId,
    overrides: member.overrides,
  }));
  const lastRunOf = new Map(lastRuns.map((run) => [run.fileShareId, run]));
  const activeOf = new Map<string, (typeof active)[number]>();
  for (const run of active) {
    // A running run wins over a queued one; the newest queued one otherwise.
    const current = activeOf.get(run.lockShareId);
    if (!current || (current.status === "queued" && run.status !== "queued")) {
      activeOf.set(run.lockShareId, run);
    }
  }
  const latestOf = new Map(latestSnapshots.map((snap) => [snap.fileShareId, snap]));
  const pointsOf = new Map(pointCounts.map((row) => [row.fileShareId, Number(row.n)]));
  const ackOf = new Map(acknowledgements.map((row) => [row.fileShareId, row]));
  const reportsOf = new Map<string, ShareReadinessReport[]>();
  for (const report of reports) {
    const list = reportsOf.get(report.fileShareId) ?? [];
    list.push({
      kind: report.kind,
      snapshotId: report.snapshotId,
      readiness: report.readiness,
      checkedAt: report.checkedAt,
    });
    reportsOf.set(report.fileShareId, list);
  }

  return shares.map((share): ShareFact => {
    const job = shareJobOf(share, protectionJobs, protectionMembers);
    const anyJob = jobs.find((candidate) =>
      members.some((member) => member.fileShareId === share.id && member.jobId === candidate.id),
    );
    const member = members.find((row) => row.fileShareId === share.id);
    const isProtected = shareProtected(share, protectionJobs, protectionMembers);
    const lastRun = lastRunOf.get(share.id) ?? null;
    const latest = latestOf.get(share.id) ?? null;
    const latestWarning = lastRun?.status === "warning" && lastRun.id === latest?.runId;
    const readiness = shareReadiness({
      latestResticSnapshotId: latest?.resticSnapshotId ?? null,
      latestBackupWarning: latestWarning,
      reports: reportsOf.get(share.id) ?? [],
    });
    const verifyOverdue =
      readiness.state !== "no_backup" && shareVerifyOverdue(readiness.checkedAt, now);
    const staleAfterHours = shareStaleBackupHours(share, protectionJobs, protectionMembers, now);
    const since = shareProtectedSince(share, job);
    const overdue =
      isProtected && now.getTime() - since.getTime() > staleAfterHours * 60 * 60 * 1000;
    const failed = isProtected && lastRun?.status === "failed";
    let warnings = false;
    if (lastRun?.status === "warning") {
      const causes = shareWarningCauses(
        (lastRun.stats?.items as Record<string, number> | undefined) ?? {},
      ).map((cause) => cause.code as string);
      const ack = ackOf.get(share.id);
      const covered =
        ack !== undefined &&
        (ack.runId === lastRun.id || causes.every((cause) => ack.causes.includes(cause)));
      warnings = !covered;
    }
    const activeRun = activeOf.get(share.id) ?? null;
    const standing: ShareStanding = share.retiredAt
      ? "retired"
      : failed
        ? "failed"
        : activeRun && activeRun.status !== "queued"
          ? "running"
          : !isProtected
            ? "no_job"
            : overdue
              ? "overdue"
              : warnings
                ? "warning"
                : readiness.state === "no_backup"
                  ? "no_backup"
                  : "ok";
    return {
      share,
      job: anyJob ? { id: anyJob.id, name: anyJob.name, enabled: anyJob.enabled } : null,
      includes: member?.overrides?.includes ?? [],
      protected: isProtected,
      readiness: { state: readiness.state, checkedAt: readiness.checkedAt, overdue: verifyOverdue },
      lastBackupRun: lastRun,
      activeRun,
      failed,
      warnings,
      overdue,
      staleAfterHours,
      restorePoints: pointsOf.get(share.id) ?? 0,
      standing,
    };
  });
}

/** The tenant's shares in figures (retired shares are not counted). */
export function shareCountsOf(facts: readonly ShareFact[]): ShareCounts {
  let lastSuccess: Date | null = null;
  const live = facts.filter((fact) => fact.share.retiredAt === null);
  for (const fact of live) {
    const at = fact.share.lastSuccessAt;
    if (at && (!lastSuccess || at > lastSuccess)) {
      lastSuccess = at;
    }
  }
  return {
    total: live.length,
    protected: live.filter((fact) => fact.protected).length,
    withoutJob: live.filter((fact) => !fact.protected).length,
    failed: live.filter((fact) => fact.failed).length,
    warnings: live.filter((fact) => fact.warnings).length,
    lastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
  };
}

/** The ids of the shares that are protected (an SQL fragment for overviews that count). */
export const PROTECTED_SHARE_SQL = sql`
  ${fileShares.retiredAt} IS NULL AND EXISTS (
    SELECT 1 FROM ${backupJobMembers} m JOIN ${backupJobs} j ON j.id = m.job_id
     WHERE m.file_share_id = ${fileShares.id} AND j.kind = 'share' AND j.enabled
  )`;
