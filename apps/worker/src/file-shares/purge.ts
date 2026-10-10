/**
 * `file-share-purge` (docs/FILESHARES.md 8.6): deleting a share's backups, an explicit action of
 * an admin (the api queues it, Phase C). Every object under `file-shares/<id>/` of the primary
 * target, the restic cache volume through the mounter, the share's secrets, then the rows (the
 * runs, restore points, catalog and reports follow by cascade, and so do the copy jobs that read
 * from or write to it). Audited. Removing a share from a job, or retiring it, never deletes
 * backups; a share with a run in progress is not purged (the job is retried).
 */
import { type FileShareJobPayload, fileShareRepositoryPrefix } from "@restow/core";
import { fileShareRuns, fileShares, secrets } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import { withTenantTx } from "../handlers/framework.js";
import { type FileShareDeps, reportableMessage } from "./common.js";

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
  const prefix = fileShareRepositoryPrefix(fileShareId);
  let objects = 0;
  for (const key of await targets.primary.list(prefix)) {
    await targets.primary.delete(key);
    objects++;
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
      details: { name: share.name, protocol: share.protocol, objects },
    });
  });
  deps.runtime.logger.info("file share purged", { tenantId, fileShareId, objects });
  return { objects };
}
