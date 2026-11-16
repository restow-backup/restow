import {
  type Database,
  type RepositoryCopy,
  type RepositoryCopyState,
  repositoryCopies,
  storageTargets,
} from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import { withTenantTx } from "../../lib/tenant-context.js";

/**
 * How far the copies of the tenant's restic repositories are (docs/STORAGE.md, "restic
 * repositories on copies"): one row per repository (a container's, a machine's, a file share's)
 * and copy target, kept by the worker (apps/worker repository-copies). The storage page shows "x
 * of y repositories current" per copy target; the page of a container, machine or file share
 * shows its copy on each copy target.
 */
export interface RepositoryCopyDto {
  prefix: string;
  kind: "container" | "machine" | "file_share";
  ownerId: string;
  targetId: string;
  /** The copy target's name; null for the installation default's own copy. */
  targetName: string | null;
  state: RepositoryCopyState;
  /** Restore points the server keeps that the primary holds. */
  primarySnapshots: number;
  /** Of these, how many the copy lacks (the lag). */
  missingSnapshots: number;
  /** The newest restore point on the copy (its id on the primary), shortened. */
  lastSnapshotId: string | null;
  lastCopiedAt: string | null;
  lastAttemptAt: string | null;
  /** Why the last attempt failed, or what the check found. */
  lastError: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastDataCheckAt: string | null;
  /** Retention on the copy was due but nothing was deleted: write-once, restore mode, a lock. */
  deletionsDeferred: string | null;
  /** Since when the copy is not current (null while it is). */
  troubleSince: string | null;
}

export interface RepositoryCopyTargetDto {
  targetId: string;
  targetName: string | null;
  total: number;
  current: number;
  behind: number;
  failed: number;
  pending: number;
}

export interface RepositoryCopiesDto {
  targets: RepositoryCopyTargetDto[];
  repositories: RepositoryCopyDto[];
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

function dtoOf(row: RepositoryCopy, names: ReadonlyMap<string, string | null>): RepositoryCopyDto {
  return {
    prefix: row.prefix,
    kind: row.kind,
    ownerId: row.ownerId,
    targetId: row.targetId,
    targetName: names.get(row.targetId) ?? null,
    state: row.state,
    primarySnapshots: row.primarySnapshots,
    missingSnapshots: row.missingSnapshots,
    lastSnapshotId: row.lastSnapshotId?.slice(0, 8) ?? null,
    lastCopiedAt: iso(row.lastCopiedAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastError: row.lastError,
    lastCheckAt: iso(row.lastCheckAt),
    lastCheckOk: row.lastCheckOk,
    lastDataCheckAt: iso(row.lastDataCheckAt),
    deletionsDeferred: row.deletionsDeferred,
    troubleSince: iso(row.troubleSince),
  };
}

async function loadCopies(database: Database, tenantId: string, ownerId?: string) {
  return withTenantTx(database, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(repositoryCopies)
      .where(
        and(
          eq(repositoryCopies.tenantId, tenantId),
          ownerId ? eq(repositoryCopies.ownerId, ownerId) : undefined,
        ),
      )
      .orderBy(asc(repositoryCopies.targetId), asc(repositoryCopies.prefix));
    const targets = await tx
      .select({ id: storageTargets.id, name: storageTargets.name, role: storageTargets.role })
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    return { rows, targets };
  });
}

/** GET /storage/repository-copies: every repository copy of the tenant, summed per copy target. */
export async function repositoryCopyStatus(
  database: Database,
  tenantId: string,
): Promise<RepositoryCopiesDto> {
  const { rows, targets } = await loadCopies(database, tenantId);
  // Rows of a target that is no copy any more (promoted, removed) wait for the worker's next pass.
  const copies = new Set(targets.filter((t) => t.role === "copy").map((t) => t.id));
  const names = new Map(targets.map((target) => [target.id, target.name ?? null]));
  const current = rows.filter((row) => copies.has(row.targetId) || row.targetId.includes(":copy:"));
  const summary = new Map<string, RepositoryCopyTargetDto>();
  for (const row of current) {
    const entry = summary.get(row.targetId) ?? {
      targetId: row.targetId,
      targetName: names.get(row.targetId) ?? null,
      total: 0,
      current: 0,
      behind: 0,
      failed: 0,
      pending: 0,
    };
    entry.total++;
    entry[row.state]++;
    summary.set(row.targetId, entry);
  }
  return {
    targets: [...summary.values()],
    repositories: current.map((row) => dtoOf(row, names)),
  };
}

/** GET /storage/repository-copies/objects/:id: the copies of one object's repository. */
export async function objectCopyStatus(
  database: Database,
  tenantId: string,
  ownerId: string,
): Promise<{ copies: RepositoryCopyDto[] }> {
  const { rows, targets } = await loadCopies(database, tenantId, ownerId);
  const copies = new Set(targets.filter((t) => t.role === "copy").map((t) => t.id));
  const names = new Map(targets.map((target) => [target.id, target.name ?? null]));
  return {
    copies: rows
      .filter((row) => copies.has(row.targetId) || row.targetId.includes(":copy:"))
      .map((row) => dtoOf(row, names)),
  };
}
