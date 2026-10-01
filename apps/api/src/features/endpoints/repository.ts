import {
  type RepositoryAccess,
  type StorageBackend,
  endpointPrefix,
  resticBinary,
  resticCacheBase,
  withRepository,
} from "@restow/core";
import {
  type Database,
  type Endpoint,
  EndpointRepositoryBusyError,
  acquireEndpointRepositoryLock,
  secrets,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { readSecret } from "../../lib/secrets.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { resolveTenantStorage } from "../restore/storage.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";

/**
 * Access to an endpoint's restic repository from the API process
 * (docs/AGENT.md). The repository lives in the tenant's primary storage
 * target under `endpoints/<endpoint id>/`; its password is sealed with the
 * tenant key and only opened here, for the server's own work (browsing,
 * downloads, the first `init`). The agent's copy of the password never comes
 * from this module.
 */

/** Secret kind of a repository password in the secret store. */
export const REPOSITORY_SECRET_KIND = "endpoint_repository";

interface CachedStorage {
  storage: StorageBackend;
  copies: readonly StorageBackend[];
  expiresAt: number;
}

const STORAGE_TTL_MS = 60_000;
const storageCache = new Map<string, CachedStorage>();

/** The tenant's storage targets, cached briefly: the restic endpoint asks for them on every request. */
export async function tenantStorage(
  database: DbExecutor,
  tenantId: string,
  now = Date.now(),
): Promise<{ storage: StorageBackend; copies: readonly StorageBackend[] }> {
  const cached = storageCache.get(tenantId);
  if (cached && cached.expiresAt > now) {
    return cached;
  }
  const resolved = await resolveTenantStorage(database, tenantId);
  const entry = {
    storage: resolved.primary,
    copies: resolved.copies,
    expiresAt: now + STORAGE_TTL_MS,
  };
  if (storageCache.size > 500) {
    storageCache.clear();
  }
  storageCache.set(tenantId, entry);
  return entry;
}

/** Drop the cached targets of a tenant (tests, and after the storage settings changed). */
export function forgetTenantStorage(tenantId?: string): void {
  if (tenantId) {
    storageCache.delete(tenantId);
  } else {
    storageCache.clear();
  }
}

/**
 * For the server's reads: the target that holds the repository. Normally the
 * primary; after a storage migration keeps the old target attached read-only,
 * a repository that was not moved is still read from there.
 */
async function backendHolding(
  targets: { storage: StorageBackend; copies: readonly StorageBackend[] },
  prefix: string,
): Promise<StorageBackend> {
  if (await targets.storage.head(`${prefix}config`).catch(() => null)) {
    return targets.storage;
  }
  for (const copy of targets.copies) {
    if (await copy.head(`${prefix}config`).catch(() => null)) {
      return copy;
    }
  }
  return targets.storage;
}

/** Everything restic needs to open an endpoint's repository (the password opened from the secret store). */
export async function repositoryAccess(
  database: DbExecutor,
  endpoint: Pick<Endpoint, "id" | "tenantId" | "repositorySecretId">,
  options: { forWrite?: boolean } = {},
): Promise<RepositoryAccess> {
  if (!endpoint.repositorySecretId) {
    throw new ProblemError(409, "Repository password missing", {
      type: ENDPOINT_PROBLEMS.repositoryUnavailable,
      detail: "The repository password of this endpoint is not available.",
    });
  }
  const password = await readSecret(database, {
    id: endpoint.repositorySecretId,
    tenantId: endpoint.tenantId,
  });
  if (password === null) {
    throw new ProblemError(409, "Repository password missing", {
      type: ENDPOINT_PROBLEMS.repositoryUnavailable,
      detail: "The repository password of this endpoint is not available.",
    });
  }
  const prefix = endpointPrefix(endpoint.id);
  const targets = await tenantStorage(database, endpoint.tenantId);
  const storage = options.forWrite ? targets.storage : await backendHolding(targets, prefix);
  return {
    storage,
    prefix,
    repositoryPassword: password,
    endpointId: endpoint.id,
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
  };
}

export { withRepository };

/** How long a read waits for the server's own maintenance of the repository before it gives up. */
export const READ_LOCK_WAIT_MS = 2_000;

/**
 * Hold an endpoint's repository for a read (snapshot list, browsing, a
 * download): shared with other reads and the restore test, never beside
 * retention or the repository check (@restow/db `withEndpointRepositoryLock`).
 * While those run, the request is answered with "repository busy" (503) and
 * the web app asks to try again. Resolves with the function that releases it.
 */
export async function holdRepositoryForRead(
  database: Database,
  endpointId: string,
): Promise<() => Promise<void>> {
  try {
    return await acquireEndpointRepositoryLock(database.$client, endpointId, {
      mode: "shared",
      waitMs: READ_LOCK_WAIT_MS,
      pollMs: 200,
    });
  } catch (error) {
    if (error instanceof EndpointRepositoryBusyError) {
      throw new ProblemError(503, "Repository busy", {
        type: ENDPOINT_PROBLEMS.repositoryLocked,
        detail:
          "The server is maintaining this repository (retention or a repository check). Try again shortly.",
      });
    }
    throw error;
  }
}

/** Best-effort removal of everything under a repository prefix (a failed enrollment). */
export async function removeRepositoryObjects(
  storage: StorageBackend,
  prefix: string,
): Promise<void> {
  for (const key of await storage.list(prefix).catch(() => [] as string[])) {
    await storage.delete(key).catch(() => undefined);
  }
}

/** Delete the secret of a repository password (compensation for a failed enrollment). */
export async function removeSecret(tenantId: string, secretId: string): Promise<void> {
  await withTenantTx(db, tenantId, (tx) =>
    tx.delete(secrets).where(and(eq(secrets.tenantId, tenantId), eq(secrets.id, secretId))),
  );
}
