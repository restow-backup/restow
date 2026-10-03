import {
  deleteProviderSecrets,
  findProviderSecret,
  readSecret,
  upsertProviderSecret,
} from "./secrets.js";
import type { DbExecutor } from "./tenant-context.js";

/**
 * A license key entered on a Community installation (Installation, Edition), kept
 * until the full build runs. The Community build has no license module: the core
 * never verifies, parses or applies a key, it only keeps the text, sealed in the
 * encrypted secret store (installation level, kind `pending_license_key`), never in
 * a column, a log line, an audit entry or a response. The full build's license
 * module (ee/api/src/license) reads it when it starts and when its page is opened,
 * verifies it like a key entered there and, once it was either installed or
 * rejected, removes it. Until then the key grants nothing.
 */

export const PENDING_LICENSE_KEY_KIND = "pending_license_key";

/** Longest key text accepted (the same bound as the full build's license page). */
export const MAX_PENDING_LICENSE_KEY_LENGTH = 16_384;

/** The key without whitespace (mail clients wrap long keys); the verifier ignores it as well. */
export function normalizePendingLicenseKey(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export async function storePendingLicenseKey(db: DbExecutor, key: string): Promise<void> {
  await upsertProviderSecret(db, PENDING_LICENSE_KEY_KIND, normalizePendingLicenseKey(key));
}

/** Remove the stored key; false when none was stored. */
export async function removePendingLicenseKey(db: DbExecutor): Promise<boolean> {
  return (await deleteProviderSecrets(db, PENDING_LICENSE_KEY_KIND)) > 0;
}

/** Whether a key waits for the full build (its value stays sealed). */
export async function hasPendingLicenseKey(db: DbExecutor): Promise<boolean> {
  return (await findProviderSecret(db, PENDING_LICENSE_KEY_KIND)) !== null;
}

/** The stored key text, or null. Only the full build's license module reads it. */
export async function readPendingLicenseKey(db: DbExecutor): Promise<string | null> {
  const ref = await findProviderSecret(db, PENDING_LICENSE_KEY_KIND);
  if (!ref) {
    return null;
  }
  return (await readSecret(db, ref)) || null;
}
