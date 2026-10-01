/**
 * Writable tenant storage targets for the archive journal receiver. Same
 * resolution core's `resolveStorageTargets` already does for
 * features/restore/storage.ts (read-only there); this module hands back the
 * full, writable {@link StorageTargets} the receiver's chunk writer needs.
 */
import {
  type SecretReader,
  StorageTargetError,
  type StorageTargets,
  installationDefaultStorage,
  openInstallationDefault,
  resolveStorageTargets,
} from "@restow/core";
import { secrets, storageTargets } from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import { loadTenantDek, openSecret } from "../../../../apps/api/src/lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../../../apps/api/src/lib/tenant-context.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";

type Env = Record<string, string | undefined>;

/** The installation-default targets, exactly as the worker and the restore reader build them. */
export function defaultWritableStorage(env: Env = process.env): StorageTargets {
  try {
    const opened = openInstallationDefault(installationDefaultStorage(env));
    return {
      primary: opened.primary.backend,
      copies: opened.copy ? [opened.copy.backend] : [],
    };
  } catch (error) {
    if (error instanceof StorageTargetError) {
      throw new ProblemError(503, "Storage not configured", { detail: error.message });
    }
    throw error;
  }
}

function tenantSecretReader(tx: DbExecutor, tenantId: string): SecretReader {
  return {
    async get(secretId) {
      const [row] = await tx
        .select({ ciphertext: secrets.ciphertext, keyVersion: secrets.keyVersion })
        .from(secrets)
        .where(and(eq(secrets.tenantId, tenantId), eq(secrets.id, secretId)))
        .limit(1);
      if (!row) {
        return null;
      }
      const dek = await loadTenantDek(tx, tenantId, row.keyVersion);
      return openSecret(dek, secretId, row.ciphertext);
    },
  };
}

/** The tenant's storage targets for writing, falling back to the installation defaults. */
export async function resolveTenantWritableStorage(
  db: DbExecutor,
  tenantId: string,
  defaults: () => StorageTargets = defaultWritableStorage,
): Promise<StorageTargets> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId))
      .orderBy(asc(storageTargets.createdAt));
    const resolved = await resolveStorageTargets(rows, {
      secrets: tenantSecretReader(tx, tenantId),
      defaults,
    });
    return { primary: resolved.primary, copies: resolved.copies };
  });
}
