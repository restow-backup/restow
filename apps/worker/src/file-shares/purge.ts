/**
 * `file-share-purge` (docs/FILESHARES.md 8.6): deleting a share's backups, an explicit action of
 * an admin (the api queues it, Phase C). Every object under `file-shares/<id>/` of the primary
 * target and of every copy target (the repository copies of 0.5.0, docs/STORAGE.md "restic
 * repositories on copies"), the restic cache volume through the mounter, the share's secrets, then the rows (the
 * runs, restore points, catalog and reports follow by cascade, and so do the copy jobs that read
 * from or write to it). Audited. Removing a share from a job, or retiring it, never deletes
 * backups; a share with a run in progress is not purged (the job is retried).
 *
 * On write-once storage (docs/STORAGE.md, "Write-once storage") nothing can be deleted: the
 * repository (and an earlier chain at the share's first prefix) stays where it is, with its
 * sealed password next to it, and only Restow's records of the share go. The audit entry counts
 * what was kept (`kept`).
 *
 * In restore mode (a database dump was restored, docs/STORAGE.md) nothing is purged: the job
 * fails with the deletion guard's refusal and is tried again; the api does not queue a purge
 * meanwhile.
 */
import {
  type FileShareJobPayload,
  fileShareRepositoryPrefix,
  isDeleteRefused,
  lockedErrorOf,
  withDeletionPermit,
} from "@restow/core";
import { fileShareRuns, fileShares, secrets } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import {
  primaryWriteOnce,
  type ResolvedTenantStorage,
  withTenantTx,
} from "../handlers/framework.js";
import { type FileShareDeps, reportableMessage, shareRepositoryPrefix } from "./common.js";

export class FileSharePurgeBusyError extends Error {
  constructor(shareId: string) {
    super(`file share ${shareId} has a run in progress; its backups are purged afterwards`);
    this.name = "FileSharePurgeBusyError";
  }
}

export async function purgeShare(
  deps: FileShareDeps,
  payload: FileShareJobPayload,
): Promise<{ objects: number } | null> {
  const { tenantId, fileShareId } = payload;
  const share = await withTenantTx(deps.db, tenantId, async (tx) => {
    const [row] = await tx.select().from(fileShares).where(eq(fileShares.id, fileShareId)).limit(1);
    if (!row) {
      return null;
    }
    const [busy] = await tx
      .select({ id: fileShareRuns.id })
      .from(fileShareRuns)
      .where(
        and(
          eq(fileShareRuns.lockShareId, fileShareId),
          inArray(fileShareRuns.status, ["starting", "running"]),
        ),
      )
      .limit(1);
    if (busy) {
      throw new FileSharePurgeBusyError(fileShareId);
    }
    return row;
  });
  if (!share) {
    return null;
  }
  const targets = await deps.runtime.storage.get(tenantId);
  const writeOnce = primaryWriteOnce(targets);
  // The primary, then every copy target (its repository copy lies under the same prefix).
  const places = [
    { backend: targets.primary, writeOnce },
    ...((targets as Partial<ResolvedTenantStorage>).targets
      ?.filter((target) => target.role === "copy")
      .map((target) => ({ backend: target.backend, writeOnce: target.writeOnce === true })) ?? []),
  ];
  const prefixes = [
    ...new Set([shareRepositoryPrefix(share), fileShareRepositoryPrefix(share.id)]),
  ];
  let objects = 0;
  let kept = 0;
  let locked = 0;
  let lockedUntil = null as Date | null;
  // Throws DeletionsHeldError in restore mode: the share, its rows and its backups all stay.
  await withDeletionPermit({ pass: "file_share_purge", tenantId }, async () => {
    for (const place of places) {
      for (const prefix of prefixes) {
        for (const key of await place.backend.list(prefix)) {
          if (place.writeOnce) {
            kept++;
            continue;
          }
          try {
            await place.backend.delete(key);
            objects++;
          } catch (error) {
            // A write-once share the probe has not seen yet: kept, like everything there.
            if (isDeleteRefused(error)) {
              kept++;
              continue;
            }
            // Immutable backups (docs/STORAGE.md): what is still locked cannot be purged yet.
            const refusal = lockedErrorOf(error);
            if (!refusal) {
              throw error;
            }
            locked++;
            if (refusal.retainUntil && (!lockedUntil || refusal.retainUntil > lockedUntil)) {
              lockedUntil = refusal.retainUntil;
            }
          }
        }
      }
    }
  });
  if (kept > 0) {
    deps.runtime.logger.warn(
      "file share purge: the storage is write-once, the share's repository stays where it is",
      { tenantId, fileShareId, kept },
    );
  }
  if (locked > 0) {
    throw new Error(
      `${locked} objects of the file share's repository are still locked${
        lockedUntil ? ` until ${lockedUntil.toISOString()}` : ""
      } (immutable backups); purge it again after that`,
    );
  }
  try {
    await deps.runner.removeCache(fileShareId);
  } catch (error) {
    // The mounter removes an orphaned cache volume itself at its next start.
    deps.runtime.logger.warn("the file share's cache volume could not be removed", {
      fileShareId,
      errorMessage: reportableMessage(error),
    });
  }
  await withTenantTx(deps.db, tenantId, async (tx) => {
    await tx.delete(fileShares).where(eq(fileShares.id, fileShareId));
    const secretIds = [share.credentialSecretId, share.repositorySecretId].filter(
      (id): id is string => typeof id === "string",
    );
    if (secretIds.length > 0) {
      await tx.delete(secrets).where(inArray(secrets.id, secretIds));
    }
    await appendAuditEntry(tx, {
      tenantId,
      actor: "system",
      action: "file_share.purged",
      target: fileShareId,
      targetType: "file_share",
      details: { name: share.name, protocol: share.protocol, objects, kept },
    });
  });
  deps.runtime.logger.info("file share purged", { tenantId, fileShareId, objects });
  return { objects };
}
