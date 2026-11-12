/**
 * What the file share jobs of the worker share (docs/FILESHARES.md 8): their dependencies, the
 * installation settings, opening a share's repository for the server's own work and the share's
 * secrets, reports, and the one lock that keeps the server's own work on a repository from
 * overlapping (the endpoints' advisory lock, keyed by the share).
 */

import type { HostResolver, StorageBackend } from "@restow/core";
import {
  ensureRepositoryPasswordFile,
  FILE_SHARE_PASSWORD_KIND,
  type FileShareSettings,
  fileShareRepositoryKey,
  fileShareSettingsOf,
  type MounterRunnerCaps,
  mounterRunnerCapsFromEnv,
  type RepositoryAccess,
  type RunnerClient,
  repositoryPrefixOf,
  resticBinary,
  resticCacheBase,
  SHARE_SNAPSHOT_ROOT,
} from "@restow/core";
import {
  type Database,
  type FileShare,
  fileShareReports,
  fileShares,
  type NewFileShareReport,
  type RepositoryLockMode,
  settings,
  withEndpointRepositoryLock,
} from "@restow/db";
import { eq } from "drizzle-orm";
import type PgBoss from "pg-boss";
import {
  PgSecretReader,
  tenantRunner,
  type WorkerRuntime,
  withTenantTx,
} from "../handlers/framework.js";
import { reportRepositoryPasswordFinding, targetIdOfBackend } from "../restore-mode.js";

export interface FileShareDeps {
  /** The application role (Row Level Security). */
  readonly db: Database;
  /** The installation role, for scans across tenants. */
  readonly providerDb: Database;
  readonly runtime: Pick<
    WorkerRuntime,
    "keyrings" | "storage" | "logger" | "now" | "shutdownSignal"
  >;
  /** The mounter's runner operations (dispatch, monitor, purge). */
  readonly runner: RunnerClient;
  /** pg-boss, to queue follow-up jobs (catalog after a backup); absent in some tests. */
  readonly boss?: Pick<PgBoss, "send">;
  /** The mounter's caps (RESTOW_MOUNTER_MAX_RUNNERS, ...), as the worker's environment says. */
  readonly mounterCaps?: MounterRunnerCaps;
  /** Name resolution for the address judgement (tests pin it). */
  readonly resolve?: HostResolver;
  /** Where the share root is in a restore point (`/share`; tests run the runner elsewhere). */
  readonly snapshotRoot?: string;
  /** How long a job waits for other work on the same repository. */
  readonly maintenanceLockWaitMs?: number;
  /** New starts are paused for an update (#46): the dispatcher starts no run meanwhile. */
  readonly startsPaused?: () => boolean;
  /**
   * Restore mode after restoring a database dump (restore-mode.ts): runs queued, or started,
   * before this are from the restored dump and are held (cancelled with the explanation), never
   * started or watched on. Null while restore mode is off.
   */
  readonly holdRunsBefore?: () => Promise<Date | null>;
}

export const MAINTENANCE_LOCK_WAIT_MS = 60_000;

export function snapshotRootOf(deps: FileShareDeps): string {
  return deps.snapshotRoot ?? SHARE_SNAPSHOT_ROOT;
}

/** The installation settings (7.4) with defaults and the mounter's caps applied. */
export async function loadFileShareSettings(deps: FileShareDeps): Promise<FileShareSettings> {
  const [row] = await deps.providerDb
    .select({ value: settings.fileShareSettings })
    .from(settings)
    .limit(1);
  return fileShareSettingsOf(row?.value ?? {}, deps.mounterCaps ?? mounterRunnerCapsFromEnv());
}

/** The lock key of a share's repository in the endpoints' advisory lock space. */
export function shareLockKey(shareId: string): string {
  return `file-share:${shareId}`;
}

/**
 * Run `work` while no other server work runs on the share's repository: retention and the check
 * hold it exclusively, the restore check and the catalog share it.
 */
export function withShareMaintenanceLock<T>(
  deps: FileShareDeps,
  shareId: string,
  mode: RepositoryLockMode,
  work: () => Promise<T>,
): Promise<T> {
  return withEndpointRepositoryLock(
    deps.db.$client,
    shareLockKey(shareId),
    { mode, waitMs: deps.maintenanceLockWaitMs ?? MAINTENANCE_LOCK_WAIT_MS, pollMs: 1000 },
    work,
  );
}

export class FileShareGoneError extends Error {
  constructor(shareId: string) {
    super(`file share ${shareId} does not exist or has no repository`);
    this.name = "FileShareGoneError";
  }
}

export async function loadShare(
  deps: FileShareDeps,
  tenantId: string,
  shareId: string,
): Promise<FileShare | null> {
  return withTenantTx(deps.db, tenantId, async (tx) => {
    const [row] = await tx.select().from(fileShares).where(eq(fileShares.id, shareId)).limit(1);
    return row ?? null;
  });
}

/** Open a secret of the tenant (the share password, the repository password). */
export async function openTenantSecret(
  deps: FileShareDeps,
  tenantId: string,
  secretId: string,
): Promise<string | null> {
  const keys = await deps.runtime.keyrings.get(tenantId);
  return new PgSecretReader(tenantRunner(deps.db, tenantId), tenantId, keys).get(secretId);
}

/**
 * The prefix a share's repository lies under: `file-shares/<id>/`, or the fresh prefix it began
 * under when what lay there could not be cleared (write-once storage, `file_shares.repository_prefix`).
 */
export function shareRepositoryPrefix(share: Pick<FileShare, "id" | "repositoryPrefix">): string {
  return repositoryPrefixOf("file_share", share.id, share.repositoryPrefix);
}

/** What restic needs to open a share's repository on the tenant's primary target. */
export async function shareRepositoryAccess(
  deps: FileShareDeps,
  share: Pick<FileShare, "id" | "tenantId" | "repositorySecretId" | "repositoryPrefix">,
  /** The target a run was pinned to (docs/STORAGE.md, "Runs and storage changes"); else the primary. */
  storage?: StorageBackend,
): Promise<RepositoryAccess> {
  if (!share.repositorySecretId) {
    throw new FileShareGoneError(share.id);
  }
  const password = await openTenantSecret(deps, share.tenantId, share.repositorySecretId);
  if (password === null) {
    throw new FileShareGoneError(share.id);
  }
  const backend = storage ?? (await deps.runtime.storage.get(share.tenantId)).primary;
  return {
    storage: backend,
    prefix: shareRepositoryPrefix(share),
    repositoryPassword: password,
    repositoryKey: fileShareRepositoryKey(share.id),
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
  };
}

/** The share and what restic needs to open its repository. */
export async function openShareRepository(
  deps: FileShareDeps,
  tenantId: string,
  shareId: string,
): Promise<{ share: FileShare; access: RepositoryAccess }> {
  const share = await loadShare(deps, tenantId, shareId);
  if (!share) {
    throw new FileShareGoneError(shareId);
  }
  return { share, access: await shareRepositoryAccess(deps, share) };
}

/**
 * Keep the repository password sealed next to the repository (5.4): restow-restore opens the
 * repository from the storage target and the master key alone. A failure is logged only.
 */
export async function keepSharePasswordFile(
  deps: FileShareDeps,
  share: Pick<FileShare, "id" | "tenantId">,
  access: Pick<RepositoryAccess, "storage" | "repositoryPassword" | "prefix">,
): Promise<void> {
  try {
    const keys = await deps.runtime.keyrings.get(share.tenantId);
    await ensureRepositoryPasswordFile(FILE_SHARE_PASSWORD_KIND, access.storage, {
      tenantId: share.tenantId,
      id: share.id,
      password: access.repositoryPassword,
      keys,
      prefix: access.prefix,
      // A stored document that differs is never replaced: it may be the only copy of the
      // password of backups the database does not know (after restoring a database dump).
      onDifferent: async (finding) =>
        reportRepositoryPasswordFinding(
          deps.providerDb,
          {
            tenantId: share.tenantId,
            targetId: await targetIdOfBackend(
              (id) => deps.runtime.storage.get(id),
              share.tenantId,
              access.storage,
            ),
            objectKey: finding.key,
            storedSha256: finding.storedSha256,
            kind: finding.kind,
          },
          deps.runtime.logger,
        ),
    });
  } catch (error) {
    deps.runtime.logger.warn("could not store the sealed file share repository password", {
      tenantId: share.tenantId,
      fileShareId: share.id,
      errorMessage: reportableMessage(error),
    });
  }
}

/** Write a report of the server's own work on a share. */
export async function writeShareReport(
  deps: FileShareDeps,
  tenantId: string,
  report: Omit<NewFileShareReport, "tenantId" | "checkedAt">,
  now: Date,
): Promise<void> {
  await withTenantTx(deps.db, tenantId, async (tx) => {
    await tx.insert(fileShareReports).values({ ...report, tenantId, checkedAt: now });
  });
}

/** A message safe to store and show: one line, no credentials, bounded. */
export function reportableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
}

/** How a share is named in alerts. */
export function shareName(share: Pick<FileShare, "name">): string {
  return share.name;
}
