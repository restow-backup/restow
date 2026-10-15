import {
  type ResticLockRegistry,
  type ShareQuotaUsage,
  type StorageBackend,
  fileShareRepositoryPrefix,
  measureRepositoryBytes,
  shareBudgetBytes,
  shareRemainingBytes,
  tenantShareBudgetBytes,
} from "@restow/core";
import { fileShareRepositoryLocks, fileShares } from "@restow/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { fileShareSettings } from "./settings.js";

/**
 * What the restic route of the file share runners keeps track of (docs/FILESHARES.md 5.3, 7.4):
 * the lock files a backup runner wrote (persisted, so a restarted api still lets restic release
 * them and maintenance tells them from stale ones), the bytes a share's repository takes, and
 * whether an upload still fits the share's and the tenant's budget.
 */

export interface ShareKey {
  tenantId: string;
  fileShareId: string;
}

/** The lock files the runners of a share wrote, in `file_share_repository_locks`. */
export function shareLockRegistry(share: ShareKey): ResticLockRegistry {
  const where = (name: string) =>
    and(
      eq(fileShareRepositoryLocks.fileShareId, share.fileShareId),
      eq(fileShareRepositoryLocks.name, name),
    );
  return {
    isOwn: async (name) =>
      (
        await withTenantTx(db, share.tenantId, (tx) =>
          tx
            .select({ id: fileShareRepositoryLocks.id })
            .from(fileShareRepositoryLocks)
            .where(where(name))
            .limit(1),
        )
      ).length > 0,
    created: async (name) => {
      await withTenantTx(db, share.tenantId, (tx) =>
        tx
          .insert(fileShareRepositoryLocks)
          .values({ tenantId: share.tenantId, fileShareId: share.fileShareId, name })
          .onConflictDoNothing(),
      );
    },
    removed: async (name) => {
      await withTenantTx(db, share.tenantId, (tx) =>
        tx.delete(fileShareRepositoryLocks).where(where(name)),
      );
    },
  };
}

/** Measurements in progress, one per share: concurrent uploads wait for the same listing. */
const measuring = new Map<string, Promise<number>>();

function measureOnce(share: ShareKey, storage: StorageBackend): Promise<number> {
  const pending = measuring.get(share.fileShareId);
  if (pending) {
    return pending;
  }
  const measured = (async () => {
    const bytes = await measureRepositoryBytes(
      storage,
      fileShareRepositoryPrefix(share.fileShareId),
    );
    await withTenantTx(db, share.tenantId, (tx) =>
      tx
        .update(fileShares)
        .set({ repositoryBytes: bytes, repositoryMeasuredAt: new Date() })
        .where(and(eq(fileShares.id, share.fileShareId), isNull(fileShares.repositoryBytes))),
    );
    return bytes;
  })().finally(() => measuring.delete(share.fileShareId));
  measuring.set(share.fileShareId, measured);
  return measured;
}

/** What the share and its tenant's shares use and may use. */
export async function shareQuotaUsage(
  share: ShareKey,
  storage: StorageBackend,
): Promise<ShareQuotaUsage> {
  const { row, tenantUsed } = await withTenantTx(db, share.tenantId, async (tx) => {
    const [found] = await tx
      .select({ bytes: fileShares.repositoryBytes, quotaGib: fileShares.quotaGib })
      .from(fileShares)
      .where(eq(fileShares.id, share.fileShareId))
      .limit(1);
    const [total] = await tx
      .select({ bytes: sql<string | null>`sum(${fileShares.repositoryBytes})` })
      .from(fileShares)
      .where(eq(fileShares.tenantId, share.tenantId));
    return { row: found, tenantUsed: Number(total?.bytes ?? 0) };
  });
  const settings = await fileShareSettings();
  let used = row?.bytes ?? null;
  let tenant = tenantUsed;
  if (used === null) {
    used = await measureOnce(share, storage);
    tenant += used;
  }
  return {
    shareUsed: used,
    shareBudget: shareBudgetBytes(row?.quotaGib),
    tenantUsed: tenant,
    tenantBudget: tenantShareBudgetBytes(settings, share.tenantId),
  };
}

/** Bytes an upload may still add, null for no limit. */
export async function shareRemaining(
  share: ShareKey,
  storage: StorageBackend,
): Promise<number | null> {
  return shareRemainingBytes(await shareQuotaUsage(share, storage));
}

/** Count bytes an upload added (or a deletion freed); a size not measured yet is measured later. */
export async function addShareUsage(share: ShareKey, delta: number): Promise<void> {
  if (delta === 0) {
    return;
  }
  await withTenantTx(db, share.tenantId, (tx) =>
    tx
      .update(fileShares)
      .set({ repositoryBytes: sql`greatest(0, ${fileShares.repositoryBytes} + ${delta})` })
      .where(and(eq(fileShares.id, share.fileShareId), isNotNull(fileShares.repositoryBytes))),
  );
}

/** A refused upload is noted at most once a minute per share (restic sends several at once). */
const REFUSAL_NOTE_MS = 60_000;
const refusalsNoted = new Map<string, number>();

export async function noteShareQuotaRefusal(share: ShareKey, now: number): Promise<void> {
  if (now - (refusalsNoted.get(share.fileShareId) ?? 0) < REFUSAL_NOTE_MS) {
    return;
  }
  refusalsNoted.set(share.fileShareId, now);
  if (refusalsNoted.size > 10_000) {
    refusalsNoted.clear();
  }
  await withTenantTx(db, share.tenantId, (tx) =>
    tx
      .update(fileShares)
      .set({ quotaRefusedAt: new Date(now) })
      .where(eq(fileShares.id, share.fileShareId)),
  );
}
