import { type ResticSnapshot, snapshotIdIn } from "@restow/core";
import { resticSnapshotOrigins } from "@restow/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * restic's persistent id of a restore point a promotion carried over to a repository copy
 * (docs/STORAGE.md, "Promoting a copy"; table `restic_snapshot_origins`).
 *
 * `restic copy` writes every snapshot under a new id and keeps the id of the snapshot it was
 * first copied from as `original`, along a whole chain of copies. After a promotion the database
 * records the promoted copy's ids; another copy target holds the same restore point under the
 * same persistent id but an id of its own. So a recorded id is looked up on any repository by
 * itself first and then by its persistent id, which this table keeps, and needs no listing of the
 * promoted primary (which may be lost).
 */
export interface SnapshotOrigin {
  /** The full snapshot id the database records (on the repository that became the primary's). */
  readonly snapshotId: string;
  /** restic's persistent id of it (`original` of its chain of copies, else its own id). */
  readonly persistentId: string;
}

/** A snapshot's persistent id: what `restic copy` keeps along a chain of copies. */
export function persistentIdOf(snapshot: Pick<ResticSnapshot, "id" | "original">): string {
  return snapshot.original ?? snapshot.id;
}

/** The persistent id of a recorded (possibly abbreviated) id, when a promotion recorded one. */
export function persistentOfRecorded(
  origins: readonly SnapshotOrigin[],
  recorded: string,
): string | null {
  if (!recorded) {
    return null;
  }
  const matches = origins.filter((origin) => origin.snapshotId.startsWith(recorded));
  return matches.length === 1 ? (matches[0]?.persistentId ?? null) : null;
}

/**
 * The id the records name for a persistent id. After several promotions several origins share
 * one persistent id (c1 → a1, then c2 → a1): the one the records name now wins (`isRecorded`),
 * else the newest origin (`origins` come newest first from {@link loadSnapshotOrigins}), else
 * the persistent id itself (no promotion rewrote it). Deterministic either way.
 */
export function recordedOfPersistent(
  origins: readonly SnapshotOrigin[],
  persistent: string,
  isRecorded: (id: string) => boolean = () => false,
): string {
  const candidates = [
    ...origins.filter((origin) => origin.persistentId === persistent).map((o) => o.snapshotId),
    persistent,
  ];
  return candidates.find(isRecorded) ?? candidates[0] ?? persistent;
}

/**
 * The id under which a listed repository (a copy target's, a retired target's) holds the restore
 * point the database records as `recorded`: by the id itself or its `original`
 * (core `snapshotIdIn`), else by the persistent id a promotion recorded for it.
 */
export function snapshotOnListing(
  listed: readonly Pick<ResticSnapshot, "id" | "original">[],
  recorded: string,
  origins: readonly SnapshotOrigin[],
): string | null {
  const direct = snapshotIdIn(listed, recorded);
  if (direct) {
    return direct;
  }
  const persistent = persistentOfRecorded(origins, recorded);
  return persistent ? snapshotIdIn(listed, persistent) : null;
}

/** The origins recorded for one repository of the tenant. */
export async function loadSnapshotOrigins(
  db: DbExecutor,
  tenantId: string,
  prefix: string,
): Promise<SnapshotOrigin[]> {
  return (
    db
      .select({
        snapshotId: resticSnapshotOrigins.snapshotId,
        persistentId: resticSnapshotOrigins.persistentId,
      })
      .from(resticSnapshotOrigins)
      .where(
        and(eq(resticSnapshotOrigins.tenantId, tenantId), eq(resticSnapshotOrigins.prefix, prefix)),
      )
      // Newest first, then by id: a fixed order wherever several share a persistent id.
      .orderBy(desc(resticSnapshotOrigins.createdAt), asc(resticSnapshotOrigins.snapshotId))
  );
}
