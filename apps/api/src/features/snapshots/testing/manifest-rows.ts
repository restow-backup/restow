/**
 * Test support: put objects into snapshots of the manifest index the way the
 * worker does (@restow/db `recordManifestVersions`), from rows shaped like the
 * per-snapshot rows tests used to insert. Rows for a snapshot that already
 * has objects are added to them (the snapshot is mirrored again with the
 * union), so a test can add an entry to a fixture snapshot. Snapshots are
 * mirrored oldest first per object, as the worker does.
 */
import {
  type Database,
  type ManifestMirrorEntry,
  type ManifestObjectKind,
  chunkIdsFromDriver,
  manifestEntries,
  recordManifestVersions,
} from "@restow/db";
import { sql } from "drizzle-orm";

export interface ManifestFixtureRow {
  /** Make the version row that holds this object carry this id (preview and download tests). */
  id?: string;
  tenantId: string;
  snapshotId: string;
  protectedObjectId: string;
  kind: ManifestObjectKind;
  path: string;
  name?: string;
  parentPath?: string;
  size?: number;
  mtime?: Date | null;
  itemId?: string | null;
  messageId?: string | null;
  chunkRefs?: string[] | null;
  metadata?: Record<string, unknown> | null;
  deleted?: boolean;
}

function toEntry(row: ManifestFixtureRow): ManifestMirrorEntry {
  const slash = row.path.lastIndexOf("/");
  return {
    kind: row.kind,
    path: row.path,
    name: row.name ?? (slash < 0 ? row.path : row.path.slice(slash + 1)),
    parentPath: row.parentPath ?? (slash < 0 ? "" : row.path.slice(0, slash)),
    size: row.size ?? 0,
    mtime: row.mtime ?? null,
    itemId: row.itemId ?? null,
    messageId: row.messageId ?? null,
    chunkRefs: row.chunkRefs ?? null,
    metadata: row.metadata ?? null,
    deleted: row.deleted ?? false,
  };
}

interface ExistingRow extends Record<string, unknown> {
  id: string;
  kind: ManifestObjectKind;
  path: string;
  name: string;
  parent_path: string;
  size: string | number;
  mtime: Date | string | null;
  item_id: string | null;
  message_id: string | null;
  chunk_refs: unknown;
  metadata: Record<string, unknown> | null;
  deleted: boolean;
}

async function existingEntries(
  db: Database,
  tenantId: string,
  snapshotId: string,
): Promise<(ManifestMirrorEntry & { id: string })[]> {
  const result = await db.execute<ExistingRow>(sql`
    SELECT m.* FROM ${manifestEntries({ tenantId, snapshots: sql`s.id = ${snapshotId}::uuid`, chunks: true })} AS m
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    kind: row.kind,
    path: row.path,
    name: row.name,
    parentPath: row.parent_path,
    size: Number(row.size),
    mtime: row.mtime === null ? null : new Date(row.mtime),
    itemId: row.item_id,
    messageId: row.message_id,
    chunkRefs: row.chunk_refs === null ? null : chunkIdsFromDriver(row.chunk_refs),
    metadata: row.metadata,
    deleted: row.deleted,
  }));
}

/** Add `rows` to their snapshots' objects in the manifest index. */
export async function insertManifestRows(
  db: Database,
  rows: readonly ManifestFixtureRow[],
): Promise<void> {
  const bySnapshot = new Map<string, ManifestFixtureRow[]>();
  for (const row of rows) {
    bySnapshot.set(row.snapshotId, [...(bySnapshot.get(row.snapshotId) ?? []), row]);
  }
  const ids = [...bySnapshot.keys()];
  const sequences = await db.execute<{ id: string; sequence: number }>(sql`
    SELECT id::text AS id, sequence FROM snapshots
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    ORDER BY protected_object_id, sequence
  `);
  for (const snapshot of sequences.rows) {
    const group = bySnapshot.get(snapshot.id) ?? [];
    const first = group[0];
    if (!first) {
      continue;
    }
    const scope = {
      tenantId: first.tenantId,
      protectedObjectId: first.protectedObjectId,
      snapshotId: snapshot.id,
      sequence: Number(snapshot.sequence),
    };
    const existing = await existingEntries(db, scope.tenantId, scope.snapshotId);
    await db.transaction(async (tx) => {
      await recordManifestVersions(tx, scope, [...existing, ...group.map(toEntry)]);
      // Mirroring a snapshot again gives its own new rows new ids; keep the ids a test already holds.
      for (const row of [...existing, ...group].filter((candidate) => candidate.id !== undefined)) {
        await tx.execute(sql`
          UPDATE manifest_versions SET id = ${row.id}::uuid
          WHERE NOT EXISTS (SELECT 1 FROM manifest_versions WHERE id = ${row.id}::uuid)
            AND id = (
            SELECT v.id FROM manifest_versions v
            WHERE v.protected_object_id = ${scope.protectedObjectId}::uuid
              AND v.path = ${row.path} AND v.first_sequence <= ${scope.sequence}::int
              AND v.last_sequence >= ${scope.sequence}::int
            LIMIT 1
          )
        `);
      }
    });
  }
}
