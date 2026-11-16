/**
 * The retention of a tenant's archive items for copying their sealed records to another
 * storage target (core `ArchiveRecordRetention`, storage/copy.ts): the scrub's copy mirror and
 * the storage migration write each record with its `retention_until`, so a WORM target locks
 * it as long as the target it was first written to; a record whose item the catalog no longer
 * holds is not copied.
 */
import type {
  ArchiveRecordCatalog,
  ArchiveRecordEntry,
  ArchiveRecordRetention,
} from "@restow/core";
import { archiveItems } from "@restow/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTxRunner } from "../progress.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function archiveRecordRetention(
  run: TenantTxRunner,
  tenantId: string,
): ArchiveRecordRetention {
  return async (itemIds) => {
    const ids = itemIds.filter((id) => UUID.test(id));
    const found = new Map<string, Date | null>();
    if (ids.length === 0) {
      return found;
    }
    const rows = await run((tx) =>
      tx
        .select({ id: archiveItems.id, retentionUntil: archiveItems.retentionUntil })
        .from(archiveItems)
        .where(and(eq(archiveItems.tenantId, tenantId), inArray(archiveItems.id, ids))),
    );
    for (const row of rows) {
      found.set(row.id, row.retentionUntil);
    }
    return found;
  };
}

/**
 * The tenant's sealed records from the catalog in keyset order (`archive_items_tenant_created_idx`
 * on tenant, created_at, id): what the scrub's copy mirror reads page by page instead of a
 * listing of the whole archive prefix. `created_at` travels as Postgres prints it, so the
 * keyset keeps its microseconds.
 */
export function pgArchiveRecordCatalog(
  run: TenantTxRunner,
  tenantId: string,
): ArchiveRecordCatalog {
  return {
    async page(after, before, limit) {
      const rows = await run((tx) =>
        tx.execute<{
          id: string;
          storage_path: string;
          created_at: string;
          retention_until: Date | string | null;
        }>(sql`
          select id, storage_path, created_at::text as created_at, retention_until
            from archive_items
           where tenant_id = ${tenantId}::uuid
             and created_at < ${before.toISOString()}::timestamptz
             ${
               after
                 ? sql`and (created_at, id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
                 : sql``
             }
           order by created_at, id
           limit ${limit}
        `),
      );
      return rows.rows.map(
        (row): ArchiveRecordEntry => ({
          key: row.storage_path,
          position: { createdAt: row.created_at, id: row.id },
          retainUntil:
            row.retention_until === null
              ? null
              : row.retention_until instanceof Date
                ? row.retention_until
                : new Date(row.retention_until),
        }),
      );
    },
  };
}
