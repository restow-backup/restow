/**
 * `file-share-catalog`: search and version history of a share (docs/FILESHARES.md 8.5). After a
 * successful backup the new restore point's changes go into `file_share_catalog`: from
 * `restic diff --json <previous> <new>` when the previous restore point is the one the catalog
 * reflects, else (the first backup, or a gap) from `restic ls --json <new>`, which closes every
 * open version and opens the listed ones. Only files below the share root are catalogued.
 * A share whose restore point holds more files than `maxEntriesPerShare` gets no catalog
 * (`last_catalog_at` stays null; browsing works without it). After retention, versions no active
 * restore point holds any more are deleted.
 */
import {
  type CatalogChange,
  type CatalogNode,
  catalogChangeOf,
  catalogNodeOf,
  catalogPlan,
  type FileShareJobPayload,
  type RepositoryAccess,
  resticDiffLines,
  resticLsLines,
  withRepository,
} from "@restow/core";
import {
  type FileShare,
  type FileShareSnapshot,
  fileShareCatalog,
  fileShareSnapshots,
  fileShares,
} from "@restow/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import type { TenantTx } from "../progress.js";
import {
  type FileShareDeps,
  loadFileShareSettings,
  openShareRepository,
  snapshotRootOf,
  withShareMaintenanceLock,
} from "./common.js";

const BATCH = 500;
/** Rows per insert (and transaction) of a full pass: 7 parameters each, well below 65535. */
const INSERT_BATCH = 5000;

function chunks<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

export interface CatalogSummary {
  snapshots: number;
  opened: number;
  closed: number;
  skipped: boolean;
}

/** Catalogue every restore point of the share that is not in the catalog yet, oldest first. */
export async function shareCatalog(
  deps: FileShareDeps,
  payload: FileShareJobPayload,
): Promise<CatalogSummary> {
  const summary: CatalogSummary = { snapshots: 0, opened: 0, closed: 0, skipped: false };
  const settings = await loadFileShareSettings(deps);
  if (!settings.catalog.enabled) {
    return { ...summary, skipped: true };
  }
  const { share, access } = await openShareRepository(deps, payload.tenantId, payload.fileShareId);
  const pending = await withTenantTx(deps.db, share.tenantId, (tx) =>
    tx
      .select()
      .from(fileShareSnapshots)
      .where(
        and(
          eq(fileShareSnapshots.fileShareId, share.id),
          eq(fileShareSnapshots.status, "active"),
          isNull(fileShareSnapshots.catalogedAt),
        ),
      )
      .orderBy(asc(fileShareSnapshots.sequence)),
  );
  if (pending.length === 0) {
    return summary;
  }
  await withShareMaintenanceLock(deps, share.id, "shared", async () => {
    let current = share;
    for (const snapshot of pending) {
      if (deps.runtime.shutdownSignal.aborted) {
        break;
      }
      if (snapshot.files > settings.catalog.maxEntriesPerShare) {
        await dropCatalog(deps, current, snapshot);
        current = { ...current, lastCatalogAt: null };
        summary.skipped = true;
        continue;
      }
      const counts = await catalogueOne(deps, current, access, snapshot);
      current = { ...current, lastCatalogAt: deps.runtime.now() };
      summary.snapshots++;
      summary.opened += counts.opened;
      summary.closed += counts.closed;
    }
  });
  return summary;
}

/** Too many files for a catalog: none for this share (8.5). */
async function dropCatalog(
  deps: FileShareDeps,
  share: FileShare,
  snapshot: FileShareSnapshot,
): Promise<void> {
  const now = deps.runtime.now();
  await withTenantTx(deps.db, share.tenantId, async (tx) => {
    await tx.delete(fileShareCatalog).where(eq(fileShareCatalog.fileShareId, share.id));
    await tx
      .update(fileShareSnapshots)
      .set({ catalogedAt: now })
      .where(eq(fileShareSnapshots.id, snapshot.id));
    await tx.update(fileShares).set({ lastCatalogAt: null }).where(eq(fileShares.id, share.id));
  });
}

async function catalogueOne(
  deps: FileShareDeps,
  share: FileShare,
  access: RepositoryAccess,
  snapshot: FileShareSnapshot,
): Promise<{ opened: number; closed: number }> {
  // The restore point the catalog reflects: the newest catalogued one before this one, as long
  // as it is still in the repository and the share still has a catalog.
  const [previous] = await withTenantTx(deps.db, share.tenantId, (tx) =>
    tx
      .select()
      .from(fileShareSnapshots)
      .where(
        and(
          eq(fileShareSnapshots.fileShareId, share.id),
          isNotNull(fileShareSnapshots.catalogedAt),
          lt(fileShareSnapshots.sequence, snapshot.sequence),
        ),
      )
      .orderBy(desc(fileShareSnapshots.sequence))
      .limit(1),
  );
  if (previous !== undefined && previous.status === "active" && share.lastCatalogAt !== null) {
    return catalogueChanges(deps, share, access, snapshot, previous);
  }
  return catalogueAll(deps, share, access, snapshot);
}

/**
 * The previous restore point is the one the catalog reflects: apply the changes of
 * `restic diff`. Only the changed files are held in memory, and they are written in one
 * transaction.
 */
async function catalogueChanges(
  deps: FileShareDeps,
  share: FileShare,
  access: RepositoryAccess,
  snapshot: FileShareSnapshot,
  previous: FileShareSnapshot,
): Promise<{ opened: number; closed: number }> {
  const root = snapshotRootOf(deps);
  const signal = deps.runtime.shutdownSignal;
  const nodes = new Map<string, CatalogNode>();
  let plan: { close: string[]; open: string[] } = { close: [], open: [] };
  await withRepository(access, async (session) => {
    const changes: CatalogChange[] = [];
    await resticDiffLines(
      session,
      previous.resticSnapshotId,
      snapshot.resticSnapshotId,
      (line) => {
        const change = catalogChangeOf(line, root);
        if (change) {
          changes.push(change);
        }
      },
      { signal },
    );
    plan = catalogPlan(changes);
    if (plan.open.length === 0) {
      return;
    }
    const wanted = new Set(plan.open);
    await resticLsLines(
      session,
      snapshot.resticSnapshotId,
      (line) => {
        const node = catalogNodeOf(line, root);
        if (node && wanted.has(node.path)) {
          nodes.set(node.path, node);
        }
      },
      { signal },
    );
  });
  const decided = plan;
  return withTenantTx(deps.db, share.tenantId, async (tx) => {
    // Versions a full pass of an abandoned restore point (interrupted, then forgotten) opened
    // after the previous one: they belong to no catalogued restore point.
    await tx
      .delete(fileShareCatalog)
      .where(
        and(
          eq(fileShareCatalog.fileShareId, share.id),
          isNull(fileShareCatalog.endSeq),
          gt(fileShareCatalog.firstSeq, previous.sequence),
        ),
      );
    let closed = 0;
    for (const batch of chunks(decided.close)) {
      const rows = await tx
        .update(fileShareCatalog)
        .set({ endSeq: snapshot.sequence })
        .where(
          and(
            eq(fileShareCatalog.fileShareId, share.id),
            isNull(fileShareCatalog.endSeq),
            inArray(fileShareCatalog.path, batch),
          ),
        )
        .returning({ id: fileShareCatalog.id });
      closed += rows.length;
    }
    const opening = decided.open
      .map((path) => nodes.get(path))
      .filter((node): node is CatalogNode => node !== undefined);
    let opened = 0;
    for (const batch of chunks(opening)) {
      opened += await insertVersions(tx, share, snapshot, batch);
    }
    await markCatalogued(tx, deps, share, snapshot);
    return { opened, closed };
  });
}

/**
 * The first restore point, or one after a gap: open a version for every file `restic ls` lists
 * and close all others. The listing is streamed and written in batches of their own
 * transactions, so memory stays bounded however many files the share holds. The older versions
 * are closed and the restore point is marked catalogued only at the end, in one transaction: an
 * interrupted pass leaves the restore point pending, and running it again skips the versions it
 * already opened.
 */
async function catalogueAll(
  deps: FileShareDeps,
  share: FileShare,
  access: RepositoryAccess,
  snapshot: FileShareSnapshot,
): Promise<{ opened: number; closed: number }> {
  const root = snapshotRootOf(deps);
  const signal = deps.runtime.shutdownSignal;
  let opened = 0;
  let pending: CatalogNode[] = [];
  const flush = async () => {
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    opened += await withTenantTx(deps.db, share.tenantId, (tx) =>
      insertVersions(tx, share, snapshot, batch),
    );
  };
  await withRepository(access, (session) =>
    resticLsLines(
      session,
      snapshot.resticSnapshotId,
      async (line) => {
        const node = catalogNodeOf(line, root);
        if (!node) {
          return;
        }
        pending.push(node);
        if (pending.length >= INSERT_BATCH) {
          await flush();
        }
      },
      { signal },
    ),
  );
  await flush();
  return withTenantTx(deps.db, share.tenantId, async (tx) => {
    const result = await tx
      .update(fileShareCatalog)
      .set({ endSeq: snapshot.sequence })
      .where(
        and(
          eq(fileShareCatalog.fileShareId, share.id),
          isNull(fileShareCatalog.endSeq),
          lt(fileShareCatalog.firstSeq, snapshot.sequence),
        ),
      );
    await markCatalogued(tx, deps, share, snapshot);
    return { opened, closed: result.rowCount ?? 0 };
  });
}

/** Open a version per node in the restore point; returns how many were new. */
async function insertVersions(
  tx: TenantTx,
  share: FileShare,
  snapshot: FileShareSnapshot,
  nodes: readonly CatalogNode[],
): Promise<number> {
  if (nodes.length === 0) {
    return 0;
  }
  const rows = await tx
    .insert(fileShareCatalog)
    .values(
      nodes.map((node) => ({
        tenantId: share.tenantId,
        fileShareId: share.id,
        path: node.path,
        name: node.name,
        size: node.size,
        mtime: node.mtime,
        firstSeq: snapshot.sequence,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: fileShareCatalog.id });
  return rows.length;
}

async function markCatalogued(
  tx: TenantTx,
  deps: FileShareDeps,
  share: FileShare,
  snapshot: FileShareSnapshot,
): Promise<void> {
  const now = deps.runtime.now();
  await tx
    .update(fileShareSnapshots)
    .set({ catalogedAt: now })
    .where(eq(fileShareSnapshots.id, snapshot.id));
  await tx.update(fileShares).set({ lastCatalogAt: now }).where(eq(fileShares.id, share.id));
}

/**
 * Delete the versions no active restore point holds any more (after retention): a version is in
 * restore point `s` when `first_seq <= s < end_seq`.
 */
export async function pruneCatalog(
  deps: FileShareDeps,
  share: Pick<FileShare, "id" | "tenantId">,
): Promise<number> {
  return withTenantTx(deps.db, share.tenantId, async (tx) => {
    const rows = await tx
      .delete(fileShareCatalog)
      .where(
        and(
          eq(fileShareCatalog.fileShareId, share.id),
          // Qualified by hand: drizzle may write bare column names inside the subquery.
          sql`NOT EXISTS (
            SELECT 1 FROM file_share_snapshots s
             WHERE s.file_share_id = file_share_catalog.file_share_id
               AND s.status = 'active'
               AND s.sequence >= file_share_catalog.first_seq
               AND (file_share_catalog.end_seq IS NULL OR s.sequence < file_share_catalog.end_seq))`,
        ),
      )
      .returning({ id: fileShareCatalog.id });
    return rows.length;
  });
}
