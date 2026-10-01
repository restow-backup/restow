/**
 * Storage key layout for archive items (docs/ARCHITECTURE.md, the chunk
 * store section; docs/ARCHIVE.md, the storage section), see FORMAT.md for
 * the full picture.
 *
 *   tenants/<tid>/archive/<year>/<month>/<itemId>.json   sealed item record
 *
 * Chunks of the original bytes live alongside ordinary backup chunks under
 * `tenants/<tid>/packs/...` (engine/layout.ts); nothing archive-specific goes
 * there, so this file only owns the item record's own key.
 */
import { tenantPrefix } from "../engine/layout.js";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} contains characters that are not allowed in a storage key`);
  }
}

export function archivePrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}archive/`;
}

/** The `<year>/<month>` bucket an item's key falls into, from its capture time (UTC). */
function archiveDateBucket(receivedAt: Date): string {
  const year = receivedAt.getUTCFullYear();
  const month = String(receivedAt.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}`;
}

export function archiveItemKey(tenantId: string, receivedAt: Date, itemId: string): string {
  assertSafeId(itemId, "archive item id");
  return `${archivePrefix(tenantId)}${archiveDateBucket(receivedAt)}/${itemId}.json`;
}
