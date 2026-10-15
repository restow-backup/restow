/**
 * Retention, repository check and restore check of a file share's repository
 * (docs/FILESHARES.md 8.4), on the generalised restic stack of the endpoints: the repository
 * opened through a loopback listener with the maintenance principal (@restow/core
 * `withRepository`), the prefix `file-shares/<id>/`, the cache key `file-share-<id>`, the opened
 * `file_share_repository` secret.
 *
 *   retention   the job's keep rules (30 daily, 12 weekly, 12 monthly by default), decided by
 *               the server from what it recorded (@restow/core `auditSnapshots`,
 *               `applyRetentionPolicy`); the newest restore point with files is never removed,
 *               whatever the rules say; a retired share keeps everything until it is purged
 *   check       `restic check` of one twentieth of the data, rotating weekly
 *   verify      the restore check of the newest restore point: its samples read back and
 *               hashed (@restow/core `restoreTestSamples`), green only when all match
 *
 * Stale locks go first, as for endpoints; a repository that stays locked is counted and, after
 * six attempts over twelve hours, announced once (`file_share.repository_locked`).
 */
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  DEFAULT_SHARE_CHECK_SUBSET_PERCENT,
  DEFAULT_SHARE_RETENTION,
  type FileShareJobPayload,
  type RepositoryAccess,
  ResticError,
  type ResticSnapshot,
  applyRetentionPolicy,
  auditSnapshots,
  isValidTimeZone,
  listRepositoryObjects,
  measureRepositoryBytes,
  resticCheck,
  resticForget,
  resticPrune,
  resticSnapshots,
  resticUnlock,
  restoreTestSamples,
  withRepository,
} from "@restow/core";
import {
  type BackupJob,
  type BackupJobMember,
  type FileShare,
  backupJobMembers,
  backupJobs,
  fileShareReports,
  fileShareRepositoryLocks,
  fileShareRuns,
  fileShareSamples,
  fileShareSnapshots,
  fileShares,
  tenants,
} from "@restow/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { checkSubset } from "../endpoints/check.js";
import {
  LOCKED_ALERT_ATTEMPTS,
  LOCKED_ALERT_MIN_MS,
  clearClientLocks,
} from "../endpoints/maintenance.js";
import { ratingOf } from "../endpoints/verify.js";
import { withTenantTx } from "../handlers/framework.js";
import { emitWebhookEvent } from "../handlers/webhooks.js";
import { raiseEvents } from "../reporting.js";
import { pruneCatalog } from "./catalog.js";
import {
  type FileShareDeps,
  keepSharePasswordFile,
  openShareRepository,
  reportableMessage,
  withShareMaintenanceLock,
  writeShareReport,
} from "./common.js";

/** The restore check could not complete; nothing was rated and the job is retried. */
export class ShareRestoreCheckIncompleteError extends Error {
  constructor(readonly reason: string) {
    super(`the restore check could not complete and will be retried: ${reason}`);
    this.name = "ShareRestoreCheckIncompleteError";
  }
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/** Remove stale lock files and, without a backup in progress, the runners' own. */
export async function clearShareLocks(
  deps: FileShareDeps,
  share: Pick<FileShare, "id" | "tenantId">,
  access: Pick<RepositoryAccess, "storage" | "prefix">,
  now: Date,
): Promise<number> {
  const { removed } = await clearClientLocks(
    access,
    {
      list: () =>
        withTenantTx(deps.db, share.tenantId, (tx) =>
          tx
            .select({
              name: fileShareRepositoryLocks.name,
              createdAt: fileShareRepositoryLocks.createdAt,
            })
            .from(fileShareRepositoryLocks)
            .where(eq(fileShareRepositoryLocks.fileShareId, share.id)),
        ),
      active: async () => {
        const [running] = await withTenantTx(deps.db, share.tenantId, (tx) =>
          tx
            .select({ id: fileShareRuns.id })
            .from(fileShareRuns)
            .where(
              and(
                eq(fileShareRuns.fileShareId, share.id),
                eq(fileShareRuns.kind, "backup"),
                inArray(fileShareRuns.status, ["starting", "running"]),
              ),
            )
            .limit(1),
        );
        return running !== undefined;
      },
      forget: async (names) => {
        await withTenantTx(deps.db, share.tenantId, (tx) =>
          tx
            .delete(fileShareRepositoryLocks)
            .where(
              and(
                eq(fileShareRepositoryLocks.fileShareId, share.id),
                inArray(fileShareRepositoryLocks.name, [...names]),
              ),
            ),
        );
      },
    },
    now,
  );
  return removed.length;
}

/** Count a maintenance run that found the repository locked; announce it once. */
export async function recordShareLocked(
  deps: FileShareDeps,
  share: Pick<FileShare, "id" | "tenantId">,
  kind: "retention" | "check",
  now: Date,
): Promise<void> {
  await withTenantTx(deps.db, share.tenantId, async (tx) => {
    const [row] = await tx
      .update(fileShares)
      .set({
        maintenanceLockedCount: sql`${fileShares.maintenanceLockedCount} + 1`,
        maintenanceLockedSince: sql`coalesce(${fileShares.maintenanceLockedSince}, ${now})`,
      })
      .where(eq(fileShares.id, share.id))
      .returning();
    if (
      !row ||
      row.lockedAlertedAt !== null ||
      row.maintenanceLockedCount < LOCKED_ALERT_ATTEMPTS ||
      !row.maintenanceLockedSince ||
      now.getTime() - row.maintenanceLockedSince.getTime() < LOCKED_ALERT_MIN_MS
    ) {
      return;
    }
    const hours = Math.floor((now.getTime() - row.maintenanceLockedSince.getTime()) / 3_600_000);
    await raiseEvents(
      tx,
      [
        {
          tenantId: share.tenantId,
          level: "warning",
          event: "file_share.repository_locked",
          message: `Retention and checks of the file share ${row.name} have found its repository locked ${row.maintenanceLockedCount} times in a row for ${hours} hours. A run may be hanging, or a lock was left behind.`,
          details: {
            fileShareId: share.id,
            objectName: row.name,
            attempts: row.maintenanceLockedCount,
            lockedSince: row.maintenanceLockedSince.toISOString(),
            lastAttempt: kind,
          },
        },
      ],
      now,
    );
    await tx.update(fileShares).set({ lockedAlertedAt: now }).where(eq(fileShares.id, share.id));
  });
}

/** A maintenance run got the lock: the count starts again. */
export async function recordShareUnlocked(
  deps: FileShareDeps,
  share: Pick<FileShare, "id" | "tenantId">,
): Promise<void> {
  await withTenantTx(deps.db, share.tenantId, (tx) =>
    tx
      .update(fileShares)
      .set({ maintenanceLockedCount: 0, maintenanceLockedSince: null, lockedAlertedAt: null })
      .where(
        and(
          eq(fileShares.id, share.id),
          sql`(${fileShares.maintenanceLockedCount} > 0 OR ${fileShares.lockedAlertedAt} IS NOT NULL)`,
        ),
      ),
  );
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** The share job's keep rules (the member's own first), and the zone they are counted in. */
async function retentionRules(deps: FileShareDeps, share: FileShare) {
  return withTenantTx(deps.db, share.tenantId, async (tx) => {
    const [row] = await tx
      .select({ member: backupJobMembers, job: backupJobs })
      .from(backupJobMembers)
      .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
      .where(and(eq(backupJobMembers.fileShareId, share.id), eq(backupJobs.kind, "share")))
      .limit(1);
    const [tenant] = await tx
      .select({ timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.id, share.tenantId));
    const member = row?.member as BackupJobMember | undefined;
    const job = row?.job as BackupJob | undefined;
    const zone = tenant?.timeZone ?? "";
    return {
      rules: member?.overrides.retention ?? job?.settings.retention ?? DEFAULT_SHARE_RETENTION,
      zone: zone && isValidTimeZone(zone) ? zone : DEFAULT_SCHEDULE_TIMEZONE,
    };
  });
}

export async function shareRetention(
  deps: FileShareDeps,
  payload: FileShareJobPayload,
): Promise<void> {
  const { share, access } = await openShareRepository(deps, payload.tenantId, payload.fileShareId);
  if (share.retiredAt) {
    return;
  }
  await withShareMaintenanceLock(deps, share.id, "exclusive", () => retain(deps, share, access));
}

async function retain(
  deps: FileShareDeps,
  share: FileShare,
  access: RepositoryAccess,
): Promise<void> {
  const now = deps.runtime.now();
  const signal = deps.runtime.shutdownSignal;
  await keepSharePasswordFile(deps, share, access);
  try {
    const removedLocks = await clearShareLocks(deps, share, access, now);
    const { rules, zone } = await retentionRules(deps, share);
    const recorded = await withTenantTx(deps.db, share.tenantId, (tx) =>
      tx
        .select()
        .from(fileShareSnapshots)
        .where(
          and(
            eq(fileShareSnapshots.fileShareId, share.id),
            eq(fileShareSnapshots.status, "active"),
          ),
        ),
    );
    const result = await withRepository(access, async (session) => {
      await resticUnlock(session).catch(() => undefined);
      const stored = await listRepositoryObjects(access.storage, access.prefix, "snapshots");
      let claimed: ResticSnapshot[] = [];
      try {
        claimed = await resticSnapshots(session, { noLock: true });
      } catch {
        // Without what restic says, nothing is flagged as dated in the future; the decision
        // rests on the server's own records alone.
      }
      const audit = auditSnapshots({
        stored: stored.map((snapshot) => ({ id: snapshot.name, storedAt: snapshot.storedAt })),
        recorded: recorded.map((snap) => ({
          snapshotId: snap.resticSnapshotId,
          finishedAt: snap.snapshotTime,
        })),
        claimed,
        now,
      });
      const decision = applyRetentionPolicy(audit.dated, rules, zone);
      // The newest restore point with files stays, whatever the rules say (8.4).
      const newestWithFiles = [...recorded]
        .filter((snap) => snap.files > 0)
        .sort((a, b) => b.sequence - a.sequence)[0];
      const remove = decision.remove.filter((id) => id !== newestWithFiles?.resticSnapshotId);
      if (remove.length > 0) {
        await resticForget(session, remove, { signal });
        await resticPrune(session, { signal });
      }
      return { audit, remove, total: stored.length };
    });
    await recordShareUnlocked(deps, share);
    const removedIds = new Set(result.remove);
    const pruned = recorded.filter((snap) => removedIds.has(snap.resticSnapshotId));
    const repositoryBytes = await measureRepositoryBytes(access.storage, access.prefix);
    await withTenantTx(deps.db, share.tenantId, async (tx) => {
      if (pruned.length > 0) {
        await tx
          .update(fileShareSnapshots)
          .set({ status: "pruned", prunedAt: now })
          .where(
            inArray(
              fileShareSnapshots.id,
              pruned.map((snap) => snap.id),
            ),
          );
      }
      await tx
        .update(fileShares)
        .set({ lastRetentionAt: now, repositoryBytes, repositoryMeasuredAt: now })
        .where(eq(fileShares.id, share.id));
    });
    if (pruned.length > 0) {
      await pruneCatalog(deps, share).catch((error) =>
        deps.runtime.logger.warn("file share catalog could not be pruned", {
          fileShareId: share.id,
          errorMessage: reportableMessage(error),
        }),
      );
    }
    await writeShareReport(
      deps,
      share.tenantId,
      {
        fileShareId: share.id,
        kind: "retention",
        readiness: null,
        summary: {
          removedSnapshots: pruned.length,
          keptSnapshots: result.total - result.remove.length,
          repositoryBytes,
          unrecordedSnapshots: result.audit.unrecorded.length,
          futureSnapshots: result.audit.flags.filter((flag) => flag.reasons.includes("future_time"))
            .length,
          removedLocks,
        },
      },
      now,
    );
    deps.runtime.logger.info("file share retention finished", {
      tenantId: share.tenantId,
      fileShareId: share.id,
      removed: pruned.length,
      unrecorded: result.audit.unrecorded.length,
    });
  } catch (error) {
    if (error instanceof ResticError && error.failure === "locked") {
      await recordShareLocked(deps, share, "retention", now);
      throw error;
    }
    await writeShareReport(
      deps,
      share.tenantId,
      {
        fileShareId: share.id,
        kind: "retention",
        readiness: null,
        summary: { errorMessage: reportableMessage(error) },
      },
      now,
    ).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export async function shareCheck(deps: FileShareDeps, payload: FileShareJobPayload): Promise<void> {
  const { share, access } = await openShareRepository(deps, payload.tenantId, payload.fileShareId);
  await withShareMaintenanceLock(deps, share.id, "exclusive", async () => {
    const now = deps.runtime.now();
    const subset = checkSubset(now, payload.subsetPercent ?? DEFAULT_SHARE_CHECK_SUBSET_PERCENT);
    await keepSharePasswordFile(deps, share, access);
    const checked = () =>
      withTenantTx(deps.db, share.tenantId, (tx) =>
        tx.update(fileShares).set({ lastCheckAt: now }).where(eq(fileShares.id, share.id)),
      );
    try {
      await clearShareLocks(deps, share, access, now);
      await withRepository(access, async (session) => {
        await resticUnlock(session).catch(() => undefined);
        await resticCheck(session, subset, { signal: deps.runtime.shutdownSignal });
      });
      await recordShareUnlocked(deps, share);
      await writeShareReport(
        deps,
        share.tenantId,
        {
          fileShareId: share.id,
          kind: "repository_check",
          readiness: "green",
          summary: { subset },
        },
        now,
      );
      await checked();
    } catch (error) {
      if (error instanceof ResticError && error.failure === "locked") {
        await recordShareLocked(deps, share, "check", now);
        throw error;
      }
      if (
        !(error instanceof ResticError) ||
        error.failure === "interrupted" ||
        error.failure === "killed"
      ) {
        // Not a finding about the repository.
        throw error;
      }
      await writeShareReport(
        deps,
        share.tenantId,
        {
          fileShareId: share.id,
          kind: "repository_check",
          readiness: "red",
          summary: { subset, errorMessage: reportableMessage(error.stderr || error.message) },
        },
        now,
      );
      await recordShareUnlocked(deps, share);
      await checked();
      deps.runtime.logger.error("file share check found problems", {
        tenantId: share.tenantId,
        fileShareId: share.id,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Restore check
// ---------------------------------------------------------------------------

export async function shareVerify(
  deps: FileShareDeps,
  payload: FileShareJobPayload,
): Promise<void> {
  const { share, access } = await openShareRepository(deps, payload.tenantId, payload.fileShareId);
  if (!share.lastSnapshotId) {
    return;
  }
  const snapshot = await withTenantTx(deps.db, share.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(fileShareSnapshots)
      .where(eq(fileShareSnapshots.id, share.lastSnapshotId as string))
      .limit(1);
    return row ?? null;
  });
  if (!snapshot || snapshot.status !== "active") {
    return;
  }
  const resticId = snapshot.resticSnapshotId;
  const samples = await withTenantTx(deps.db, share.tenantId, (tx) =>
    tx
      .select({
        path: fileShareSamples.path,
        sha256: fileShareSamples.sha256,
        size: fileShareSamples.size,
      })
      .from(fileShareSamples)
      .where(
        and(eq(fileShareSamples.fileShareId, share.id), eq(fileShareSamples.snapshotId, resticId)),
      ),
  );
  if (samples.length === 0) {
    deps.runtime.logger.info("no samples to check", {
      fileShareId: share.id,
      snapshotId: resticId,
    });
    return;
  }
  const result = await withShareMaintenanceLock(deps, share.id, "shared", () =>
    withRepository(access, (session) =>
      restoreTestSamples(session, resticId, samples, { signal: deps.runtime.shutdownSignal }),
    ),
  );
  const now = deps.runtime.now();
  if (result.transient) {
    throw new ShareRestoreCheckIncompleteError(
      result.incomplete ?? "a sampled file could not be read",
    );
  }
  const readiness = ratingOf(result);
  await withTenantTx(deps.db, share.tenantId, async (tx) => {
    const [previous] = await tx
      .select({ readiness: fileShareReports.readiness })
      .from(fileShareReports)
      .where(
        and(eq(fileShareReports.fileShareId, share.id), eq(fileShareReports.kind, "restore_test")),
      )
      .orderBy(desc(fileShareReports.checkedAt))
      .limit(1);
    await tx.insert(fileShareReports).values({
      tenantId: share.tenantId,
      fileShareId: share.id,
      kind: "restore_test",
      snapshotId: resticId,
      readiness,
      summary: {
        files: result.files,
        matched: result.matched,
        mismatched: result.mismatched.slice(0, 20),
      },
      checkedAt: now,
      alertedAt: readiness === "red" || previous?.readiness === "red" ? now : null,
    });
    await tx.update(fileShares).set({ lastRestoreTestAt: now }).where(eq(fileShares.id, share.id));
    const details = { fileShareId: share.id, objectName: share.name, snapshotId: resticId };
    if (readiness === "red") {
      await raiseEvents(
        tx,
        [
          {
            tenantId: share.tenantId,
            level: "error",
            event: "verify.red",
            message: `The restore check of the file share ${share.name} failed: ${result.mismatched.length} of ${result.files} sampled files did not match.`,
            details: { ...details, mismatched: result.mismatched.length, files: result.files },
          },
        ],
        now,
      );
    } else if (previous?.readiness === "red") {
      await raiseEvents(
        tx,
        [
          {
            tenantId: share.tenantId,
            level: "info",
            event: "verify.recovered",
            message: `The restore check of the file share ${share.name} passed again.`,
            details,
          },
        ],
        now,
      );
    }
  });
  // `verify.completed` for the tenant's webhooks (section 14), with the share as the subject.
  await emitWebhookEvent(deps.db, {
    tenantId: share.tenantId,
    event: "verify.completed",
    occurredAt: now,
    data: {
      readiness,
      objectName: share.name,
      snapshotId: resticId,
      checked: result.files,
      mismatched: result.mismatched.length,
      missing: 0,
      reasons: result.mismatched.slice(0, 5).map((entry) => entry.path),
      protectedObjectId: null,
      fileShare: { id: share.id, name: share.name, protocol: share.protocol },
    },
  }).catch((error) =>
    deps.runtime.logger.warn("verify.completed webhook could not be queued", {
      fileShareId: share.id,
      errorMessage: reportableMessage(error),
    }),
  );
  deps.runtime.logger.info("file share restore check finished", {
    tenantId: share.tenantId,
    fileShareId: share.id,
    readiness,
    files: result.files,
    matched: result.matched,
  });
}
