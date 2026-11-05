import { randomUUID } from "node:crypto";
import {
  type Dek,
  deriveInstallationSecretsKey,
  EnvKeyProvider,
  generateDek,
  INSTALLATION_SECRETS_KEY_VERSION,
  type KeyProvider,
  kekFromBase64,
  openSecret,
  type StorageBackend,
  sealSecret,
  secretAad,
} from "@restow/core";
import { findInstallationSecret, type SecretKind, secrets, tenantKeys } from "@restow/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { ProblemError } from "../problem.js";
import { type DbExecutor, withTenantTx } from "./tenant-context.js";

/**
 * The encrypted secret store (docs/ARCHITECTURE.md, Sicherheit).
 *
 * Plaintext secrets (SMTP/IMAP passwords, Entra client secrets, refresh tokens,
 * S3 credentials) never reach a table or a log line. They are sealed with
 * AES-256-GCM and stored as base64 in `secrets`; other rows reference them by
 * id (`secret_ref`). The sealing itself lives in @restow/core (secret-seal.ts)
 * so the worker opens exactly what the API sealed.
 *
 * Keys:
 *   - installation-level secrets (no tenant) use a key derived from the master
 *     key (RESTOW_MASTER_KEY) with HKDF, so the raw KEK is used for exactly one
 *     purpose (wrapping tenant DEKs) and never as a bulk cipher key;
 *   - tenant-level secrets use the tenant's DEK (`tenant_keys`), unwrapped through
 *     the {@link KeyProvider}. The DEK version is recorded so a key rotation can
 *     re-seal them.
 *
 * The secret's own id is bound as GCM additional data, so a ciphertext cannot be
 * moved to another row without failing authentication.
 */

export { openSecret, sealSecret, secretAad };

/** Version recorded for installation-level secrets (the KEK has no rotation yet). */
export const PROVIDER_KEY_VERSION = INSTALLATION_SECRETS_KEY_VERSION;

/** Identifier stored in `tenant_keys.kek_id` for DEKs wrapped by the env KEK. */
export const ENV_KEK_ID = "env:RESTOW_MASTER_KEY";

/** Raised when a secret operation needs the master key but none is configured. */
export function masterKeyMissing(): ProblemError {
  return new ProblemError(503, "Master key not configured", {
    type: "urn:restow:problem:master-key-missing",
    detail: "Set RESTOW_MASTER_KEY (32 bytes, base64) to enable encrypted storage.",
  });
}

/** The raw 32-byte KEK from configuration. */
export function masterKek(): Buffer {
  if (!config.masterKey) {
    throw masterKeyMissing();
  }
  try {
    return kekFromBase64(config.masterKey);
  } catch {
    throw new ProblemError(503, "Master key invalid", {
      type: "urn:restow:problem:master-key-invalid",
      detail: "RESTOW_MASTER_KEY must be 32 bytes, base64-encoded.",
    });
  }
}

/** The key provider that wraps and unwraps tenant DEKs under the env KEK. */
export function keyProvider(): KeyProvider {
  return new EnvKeyProvider(masterKek());
}

/** Derive the installation-level secrets key from a KEK (deterministic, see @restow/core). */
export function deriveProviderSecretsKey(kek: Buffer): Dek {
  return deriveInstallationSecretsKey(kek);
}

/** The installation-level secrets key from the configured master key. */
export function installationSecretsKey(): Dek {
  return deriveInstallationSecretsKey(masterKek());
}

export const KEY_VERSION_UNSAFE_PROBLEM = "urn:restow:problem:key-version-unsafe";

/** Where a new key version must not exist yet: every target of the tenant. */
export interface KeyVersionStorage {
  /** Primary, copies, previous targets and the installation default, as the tenant has them. */
  readonly backends: readonly Pick<StorageBackend, "list">[];
}

export interface CreateTenantKeyOptions {
  /**
   * The tenant's storage (a rotation): the new version lies above every version listed under
   * `tenants/<tid>/keys/` on any target, so a version the database lost after restoring a dump
   * is never handed out again with another key. A target that cannot be listed refuses (503).
   * Without it only a tenant without any key may get one (its first, at its creation: a new
   * tenant id has nothing in storage).
   */
  readonly storage?: KeyVersionStorage;
  readonly provider?: KeyProvider;
}

/** The highest key version any target holds for the tenant (0 without one). */
export async function highestStoredKeyVersion(
  storage: KeyVersionStorage,
  tenantId: string,
): Promise<number> {
  let highest = 0;
  for (const backend of storage.backends) {
    let keys: string[];
    try {
      keys = await backend.list(`tenants/${tenantId}/keys/`);
    } catch (error) {
      throw new ProblemError(503, "Key version cannot be chosen safely", {
        type: KEY_VERSION_UNSAFE_PROBLEM,
        detail: `A storage target of the tenant could not be listed, so a new key version could collide with one stored there (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}).`,
      });
    }
    for (const key of keys) {
      const version = Number(/\/keys\/(\d+)$/.exec(key)?.[1] ?? 0);
      if (Number.isInteger(version) && version > highest) {
        highest = version;
      }
    }
  }
  return highest;
}

/**
 * Create a fresh DEK for a tenant, wrap it and persist it as the next key
 * version. Runs inside the caller's tenant-pinned transaction. The version is
 * above the database's newest and, with `storage`, above every version stored
 * for the tenant; without `storage` the tenant must have no key yet.
 */
export async function createTenantKey(
  tx: DbExecutor,
  tenantId: string,
  options: CreateTenantKeyOptions | KeyProvider = {},
): Promise<{ keyVersion: number }> {
  const { storage, provider = keyProvider() } =
    "wrapDek" in options ? { storage: undefined, provider: options } : options;
  const [latest] = await tx
    .select({ keyVersion: tenantKeys.keyVersion })
    .from(tenantKeys)
    .where(eq(tenantKeys.tenantId, tenantId))
    .orderBy(desc(tenantKeys.keyVersion))
    .limit(1);
  if (latest && !storage) {
    throw new Error(
      "createTenantKey: a tenant that has a key gets a new version only with its storage (the versions stored there)",
    );
  }
  const stored = storage ? await highestStoredKeyVersion(storage, tenantId) : 0;
  const keyVersion = Math.max(latest?.keyVersion ?? 0, stored) + 1;
  const dek = generateDek(keyVersion);
  const wrapped = await provider.wrapDek(dek);
  await tx.insert(tenantKeys).values({
    tenantId,
    keyVersion,
    encryptedDek: wrapped.toString("base64"),
    kekId: ENV_KEK_ID,
  });
  return { keyVersion };
}

/**
 * Load a tenant DEK: the newest version, or a specific one (for reading data
 * sealed before a rotation). Runs inside the caller's tenant-pinned transaction.
 */
export async function loadTenantDek(
  tx: DbExecutor,
  tenantId: string,
  keyVersion?: number,
  provider: KeyProvider = keyProvider(),
): Promise<Dek> {
  const condition =
    keyVersion === undefined
      ? eq(tenantKeys.tenantId, tenantId)
      : and(eq(tenantKeys.tenantId, tenantId), eq(tenantKeys.keyVersion, keyVersion));
  const [row] = await tx
    .select({ encryptedDek: tenantKeys.encryptedDek })
    .from(tenantKeys)
    .where(condition)
    .orderBy(desc(tenantKeys.keyVersion))
    .limit(1);
  if (!row) {
    throw new ProblemError(500, "Tenant key missing", {
      type: "urn:restow:problem:tenant-key-missing",
      detail: "The tenant has no data encryption key; it cannot store encrypted data.",
    });
  }
  return provider.unwrapDek(Buffer.from(row.encryptedDek, "base64"));
}

export interface StoreSecretInput {
  /** Tenant the secret belongs to; omit for installation-level secrets. */
  tenantId?: string | null;
  kind: SecretKind;
  plaintext: string;
}

export interface SecretRef {
  id: string;
  tenantId: string | null;
  kind: SecretKind;
  keyVersion: number;
}

/** Resolve the sealing key for a scope (installation or tenant) within `tx`. */
async function sealingKey(tx: DbExecutor, tenantId: string | null): Promise<Dek> {
  return tenantId === null ? installationSecretsKey() : loadTenantDek(tx, tenantId);
}

/** Run `fn` in a transaction pinned to the tenant, or a plain one for the installation scope. */
function inScope<T>(
  db: DbExecutor,
  tenantId: string | null,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  return tenantId === null ? db.transaction((tx) => fn(tx)) : withTenantTx(db, tenantId, fn);
}

/** Seal and store a secret; returns the reference other rows point to. */
export async function storeSecret(db: DbExecutor, input: StoreSecretInput): Promise<SecretRef> {
  const tenantId = input.tenantId ?? null;
  return inScope(db, tenantId, async (tx) => {
    const key = await sealingKey(tx, tenantId);
    const id = randomUUID();
    await tx.insert(secrets).values({
      id,
      tenantId,
      kind: input.kind,
      ciphertext: sealSecret(key, id, input.plaintext),
      keyVersion: key.version,
    });
    return { id, tenantId, kind: input.kind, keyVersion: key.version };
  });
}

/** Replace the plaintext behind an existing reference (same id, new ciphertext). */
export async function replaceSecret(
  db: DbExecutor,
  ref: Pick<SecretRef, "id" | "tenantId">,
  plaintext: string,
): Promise<void> {
  await inScope(db, ref.tenantId, async (tx) => {
    const key = await sealingKey(tx, ref.tenantId);
    await tx
      .update(secrets)
      .set({ ciphertext: sealSecret(key, ref.id, plaintext), keyVersion: key.version })
      .where(eq(secrets.id, ref.id));
  });
}

/** Read and open a secret by reference; null when the row does not exist. */
export async function readSecret(
  db: DbExecutor,
  ref: Pick<SecretRef, "id" | "tenantId">,
): Promise<string | null> {
  return inScope(db, ref.tenantId, async (tx) => {
    const [row] = await tx.select().from(secrets).where(eq(secrets.id, ref.id)).limit(1);
    if (!row) {
      return null;
    }
    const key =
      row.tenantId === null
        ? installationSecretsKey()
        : await loadTenantDek(tx, row.tenantId, row.keyVersion);
    return openSecret(key, row.id, row.ciphertext);
  });
}

/** Remove a secret; referencing rows have their `secret_ref` set to null by the schema. */
export async function deleteSecret(
  db: DbExecutor,
  ref: Pick<SecretRef, "id" | "tenantId">,
): Promise<void> {
  await inScope(db, ref.tenantId, async (tx) => {
    await tx.delete(secrets).where(eq(secrets.id, ref.id));
  });
}

/** Find the (single) installation-level secret of a kind, e.g. the SMTP password. */
export async function findProviderSecret(
  db: DbExecutor,
  kind: SecretKind,
): Promise<SecretRef | null> {
  const row = await findInstallationSecret(db, kind);
  return row ? { id: row.id, kind: row.kind, keyVersion: row.keyVersion, tenantId: null } : null;
}

/** Remove every installation-level secret of a kind (a kind holds at most one by intent). */
export async function deleteProviderSecrets(db: DbExecutor, kind: SecretKind): Promise<number> {
  const removed = await db
    .delete(secrets)
    .where(and(isNull(secrets.tenantId), eq(secrets.kind, kind)))
    .returning({ id: secrets.id });
  return removed.length;
}

/**
 * Store or replace the installation-level secret of a kind (idempotent, used by
 * the setup wizard for the SMTP password).
 */
export async function upsertProviderSecret(
  db: DbExecutor,
  kind: SecretKind,
  plaintext: string,
): Promise<SecretRef> {
  const existing = await findProviderSecret(db, kind);
  if (existing) {
    await replaceSecret(db, existing, plaintext);
    return existing;
  }
  return storeSecret(db, { kind, plaintext });
}
