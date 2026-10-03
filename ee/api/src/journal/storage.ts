/**
 * Writable tenant storage targets for the archive journal receiver. Same
 * resolution core's `resolveStorageTargets` already does for
 * features/restore/storage.ts (read-only there); this module hands back the
 * full, writable {@link StorageTargets} the receiver's chunk writer needs.
 */
import {
  type InstallationDefaultStorage,
  type SecretReader,
  StorageTargetError,
  type StorageTargets,
  installationDefaultStorage,
  openInstallationDefault,
  resolveStorageTargets,
} from "@restow/core";
import { secrets, storageTargets } from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import { installationDefaultResolver } from "../../../../apps/api/src/lib/installation-default.js";
import { loadTenantDek, openSecret } from "../../../../apps/api/src/lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../../../apps/api/src/lib/tenant-context.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";

type Env = Record<string, string | undefined>;

function openDefaults(defaults: InstallationDefaultStorage): StorageTargets {
  const opened = openInstallationDefault(defaults);
  return {
    primary: opened.primary.backend,
    copies: opened.copy ? [opened.copy.backend] : [],
  };
}

function notConfigured(error: unknown): unknown {
  return error instanceof StorageTargetError
    ? new ProblemError(503, "Storage not configured", { detail: error.message })
    : error;
}

/** The installation-default targets an environment describes (tests). */
export function defaultWritableStorage(env: Env = process.env): StorageTargets {
  try {
    return openDefaults(installationDefaultStorage(env));
  } catch (error) {
    throw notConfigured(error);
  }
}

/**
 * The installation-default targets that apply right now, exactly as the worker
 * and the restore reader resolve them: the default saved under Installation →
 * Default storage, otherwise the environment.
 */
export async function currentDefaultWritableStorage(): Promise<StorageTargets> {
  try {
    return openDefaults(await installationDefaultResolver().storage());
  } catch (error) {
    throw notConfigured(error);
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
  defaults: () => StorageTargets | Promise<StorageTargets> = currentDefaultWritableStorage,
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
