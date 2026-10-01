import { mailfiles } from "@restow/core";
import type { Database } from "@restow/db";
import { resolveTenantStorage } from "../features/restore/storage.js";
import { loadTenantKeyring } from "../features/snapshots/content.js";

/**
 * The sealed segment store of a tenant (packages/core mailfiles/segments.ts):
 * segments are written to the tenant's primary storage target and sealed with
 * the tenant's newest data-encryption key, older key versions stay readable.
 *
 * Both halves are resolved the way the API already resolves them for restore
 * downloads and mail previews: storage through `resolveTenantStorage`
 * (features/restore/storage.ts, the tenant's primary row or the installation
 * default) and the keyring through `loadTenantKeyring`
 * (features/snapshots/content.ts). Import uploads (staging) and export files
 * use the same store.
 */
export async function segmentStoreFor(
  db: Database,
  tenantId: string,
): Promise<mailfiles.SegmentStore> {
  const storage = await resolveTenantStorage(db, tenantId);
  const keys = await loadTenantKeyring(db, tenantId);
  return new mailfiles.SegmentStore({ storage: storage.primary, keys });
}
