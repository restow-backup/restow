/**
 * Where the database records restic snapshot ids of a repository (docs/STORAGE.md, "restic
 * repositories on copies", "Promoting a copy"): the restore points themselves and everything
 * that refers to one. The worker's copy pass copies every snapshot of a machine these records
 * name, and a promotion of a copy target requires and rewrites the same set: one list, so the two
 * never disagree.
 */
import { type SQL, sql } from "drizzle-orm";

/** The kinds of restic repositories: a container's, a machine's, a file share's. */
export type RecordedRepositoryKind = "container" | "machine" | "file_share";

/** A column that records restic snapshot ids of one kind of repository, and its owner column. */
export interface RecordedSnapshotColumn {
  readonly table: string;
  readonly column: string;
  readonly owner: string;
  /** A fixed condition on the row, when the table records other things too. */
  readonly where?: string;
}

/**
 * Every column that records a restic snapshot id of a repository (fixed identifiers, never
 * input): restore points, samples of restore tests, reports, flags of the retention audit,
 * downloads, SQL backups, a machine's newest snapshot, the suspicion scan of a machine's backups
 * (whose restore point is the restic snapshot).
 */
export const RECORDED_SNAPSHOT_COLUMNS: Readonly<
  Record<RecordedRepositoryKind, readonly RecordedSnapshotColumn[]>
> = {
  container: [{ table: "pve_snapshots", column: "restic_snapshot_id", owner: "guest_id" }],
  file_share: [
    { table: "file_share_snapshots", column: "restic_snapshot_id", owner: "file_share_id" },
    { table: "file_share_samples", column: "snapshot_id", owner: "file_share_id" },
    { table: "file_share_reports", column: "snapshot_id", owner: "file_share_id" },
  ],
  machine: [
    { table: "endpoints", column: "last_snapshot_id", owner: "id" },
    { table: "endpoint_runs", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_samples", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_reports", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_snapshot_flags", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_downloads", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_sql_backups", column: "restic_snapshot_id", owner: "endpoint_id" },
    {
      table: "restore_point_suspicions",
      column: "restore_point_id",
      owner: "object_id",
      where: "object_kind = 'endpoint'",
    },
  ],
};

/** `AND <condition>` of a column, with a table alias (`t.`) or none. */
export function recordedColumnWhere(column: RecordedSnapshotColumn, alias = ""): SQL {
  return column.where ? sql.raw(` AND ${alias}${column.where}`) : sql.raw("");
}

/** The distinct values of one recorded column for one owner. */
export function recordedColumnValuesSql(
  column: RecordedSnapshotColumn,
  tenantId: string,
  ownerId: string,
): SQL {
  return sql`SELECT DISTINCT ${sql.raw(column.column)} AS value FROM ${sql.raw(column.table)}
     WHERE tenant_id = ${tenantId} AND ${sql.raw(column.owner)} = ${ownerId}
       AND ${sql.raw(column.column)} IS NOT NULL${recordedColumnWhere(column)}`;
}

/** Anything that runs a statement: a transaction or a database (drizzle, node-postgres). */
interface RecordedExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Every distinct snapshot id the database records for one repository, in any column. */
export async function recordedSnapshotIds(
  tx: RecordedExecutor,
  tenantId: string,
  kind: RecordedRepositoryKind,
  ownerId: string,
): Promise<string[]> {
  const values = new Set<string>();
  for (const column of RECORDED_SNAPSHOT_COLUMNS[kind]) {
    const result = await tx.execute(recordedColumnValuesSql(column, tenantId, ownerId));
    for (const row of result.rows) {
      values.add(String(row.value));
    }
  }
  return [...values];
}
