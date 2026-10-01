import { protectedObjects, snapshots, sources } from "@restow/db";
import { type AnyColumn, type SQL, and, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "./tenant-context.js";

/**
 * Imported mailboxes (docs/IMPORT.md) are protected objects under a source of
 * kind `import`: files brought in by hand, nothing is ever backed up from
 * them. Everything that counts, rates, lists or schedules the objects a
 * tenant PROTECTS leaves them out with these helpers, so an imported mailbox
 * never shows up as "not protected", "overdue" or "never verified". Their
 * snapshots are ordinary snapshots for restore, preview, download and retention.
 */

/** The SQL fragment (a subquery on `sources`) both helpers below are built from. */
const IMPORT_SOURCE_IDS = sql`(select ${sources.id} from ${sources} where ${sources.kind} = 'import')`;

/**
 * Condition: the object does not belong to an import source. `sourceId` is the
 * object's `source_id` column; pass another column when the table is aliased.
 */
export function notImported(sourceId: AnyColumn | SQL = protectedObjects.sourceId): SQL {
  return sql`${sourceId} not in ${IMPORT_SOURCE_IDS}`;
}

/** Condition: the snapshot belongs to a backup, not to an imported mailbox. */
export function snapshotNotImported(
  protectedObjectId: AnyColumn | SQL = snapshots.protectedObjectId,
): SQL {
  return sql`${protectedObjectId} not in (select ${protectedObjects.id} from ${protectedObjects} where ${protectedObjects.sourceId} in ${IMPORT_SOURCE_IDS})`;
}

/** Raw SQL flavour for hand-written queries: `sourceIdRef` is e.g. `o.source_id`. */
export function notImportedRaw(sourceIdRef: string): SQL {
  return notImported(sql.raw(sourceIdRef));
}

/** Raw SQL flavour of {@link snapshotNotImported}: `objectIdRef` is e.g. `s.protected_object_id`. */
export function snapshotNotImportedRaw(objectIdRef: string): SQL {
  return snapshotNotImported(sql.raw(objectIdRef));
}

/** True when the protected object belongs to an import source of the tenant. */
export async function isImportedObject(
  tx: DbExecutor,
  tenantId: string,
  objectId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: protectedObjects.id })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.id, objectId),
        eq(sources.kind, "import"),
      ),
    )
    .limit(1);
  return row !== undefined;
}
