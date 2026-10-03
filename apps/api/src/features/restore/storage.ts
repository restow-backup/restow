import {
  type InstallationDefaultStorage,
  type SecretReader,
  type StorageBackend,
  StorageTargetError,
  installationDefaultStorage,
  openInstallationDefault,
  resolveStorageTargets,
} from "@restow/core";
import { secrets, storageTargets } from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import { installationDefaultResolver } from "../../lib/installation-default.js";
import { loadTenantDek, openSecret } from "../../lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";

/**
 * Read access to a tenant's chunk store from the API process, used to stream
 * download restores. Resolution is core's `resolveStorageTargets`, the same
 * the worker writes with: the tenant's primary row wins, without one the
 * installation default (saved under Installation → Default storage, else
 * STORAGE_TARGET, STORAGE_LOCAL_PATH, S3_*; plus STORAGE_COPY_LOCAL_PATH) is
 * the primary, and copy rows always apply, so a
 * download can fall back to every copy a backup was written to. S3
 * credentials are opened from the encrypted secret store; they never leave
 * this process.
 *
 * A `previous` target (the retired primary of a completed storage migration,
 * docs/STORAGE.md) is read-only fallback too: this feature never writes
 * through `ReadableStorage`, so folding it into `copies` is exactly as safe
 * as the existing copy fallback and keeps this type unchanged for the other
 * readers of it (mail previews, the restore explorer).
 */

export interface ReadableStorage {
  readonly primary: StorageBackend;
  readonly copies: readonly StorageBackend[];
}

type Env = Record<string, string | undefined>;

function openDefaults(defaults: InstallationDefaultStorage): ReadableStorage {
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

/** The installation-default targets an environment describes (tests, and installs without a saved default). */
export function defaultStorage(env: Env = process.env): ReadableStorage {
  try {
    return openDefaults(installationDefaultStorage(env));
  } catch (error) {
    throw notConfigured(error);
  }
}

/**
 * The installation-default targets that apply right now, exactly as the
 * worker resolves them: the default saved under Installation → Default
 * storage, otherwise the environment (lib/installation-default.ts).
 */
export async function currentDefaultStorage(): Promise<ReadableStorage> {
  try {
    return openDefaults(await installationDefaultResolver().storage());
  } catch (error) {
    throw notConfigured(error);
  }
}

/** The tenant's secrets, opened inside the caller's tenant transaction. */
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

/** The tenant's storage targets for reading, falling back to the installation defaults. */
export async function resolveTenantStorage(
  db: DbExecutor,
  tenantId: string,
  defaults: () => ReadableStorage | Promise<ReadableStorage> = currentDefaultStorage,
): Promise<ReadableStorage> {
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
    // `previous` targets are never written here (this module only reads), so
    // they fold into the same read-only fallback chain as `copies`.
    return { primary: resolved.primary, copies: [...resolved.copies, ...resolved.previous] };
  });
}

/** Probe every target for `key`; the first that has it wins. */
export async function locateInStorage(
  storage: ReadableStorage,
  key: string,
): Promise<{ backend: StorageBackend; size: number } | null> {
  for (const backend of [storage.primary, ...storage.copies]) {
    const head = await backend.head(key).catch(() => null);
    if (head) {
      return { backend, size: head.size };
    }
  }
  return null;
}

/** Keys under `prefix` from the first target that lists any. */
export async function listInStorage(storage: ReadableStorage, prefix: string): Promise<string[]> {
  for (const backend of [storage.primary, ...storage.copies]) {
    const keys = await backend.list(prefix).catch(() => [] as string[]);
    if (keys.length > 0) {
      return keys;
    }
  }
  return [];
}
