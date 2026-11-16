/**
 * Whether storage targets answer for a tenant: the probe that turns "not found on every
 * target" into evidence (docs/TESTING.md, restore proof). A 404 alone proves nothing, as an
 * emptied target, an unmounted share or a wrong bucket answers every key so. A target that
 * still holds the tenant's other data, while one object is gone from it, is not empty: the
 * object was deleted (a lifecycle rule, a cleanup by hand).
 *
 * A target holds the tenant when it lists one of the tenant's wrapped keys
 * (`tenants/<tid>/keys/`, which the worker mirrors to every target) or another committed
 * manifest. A target that cannot be asked (an error) holds nothing that can be relied on.
 */
import { keyPrefix, manifestPrefix, parseManifestKey } from "../engine/layout.js";
import type { StorageTargets } from "../engine/types.js";
import type { StorageBackend } from "../storage/backend.js";

async function holdsTenant(
  target: StorageBackend,
  tenantId: string,
  except: ReadonlySet<string>,
): Promise<boolean> {
  try {
    if ((await target.list(keyPrefix(tenantId))).length > 0) {
      return true;
    }
    return (await target.list(manifestPrefix(tenantId))).some((key) => {
      const parts = parseManifestKey(key);
      return parts !== null && !parts.partial && !except.has(key);
    });
  } catch {
    return false;
  }
}

/** Whether every target holds the tenant's other data (`except`: the keys found missing). */
export async function targetsHoldTenant(
  storage: StorageTargets,
  tenantId: string,
  except: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  for (const target of [storage.primary, ...storage.copies]) {
    if (!(await holdsTenant(target, tenantId, except))) {
      return false;
    }
  }
  return true;
}
