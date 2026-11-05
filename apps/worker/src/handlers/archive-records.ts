/**
 * The retention of a tenant's archive items for copying their sealed records to another
 * storage target (core `ArchiveRecordRetention`, storage/copy.ts): the scrub's copy mirror and
 * the storage migration write each record with its `retention_until`, so a WORM target locks
 * it as long as the target it was first written to; a record whose item the catalog no longer
 * holds is not copied.
 */
import type { ArchiveRecordRetention } from "@restow/core";
import { archiveItems } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
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
