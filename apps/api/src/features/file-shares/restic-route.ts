import type { ResticLockRegistry, ResticResource, StorageBackend } from "@restow/core";
import {
  fileShareRepositoryPrefix,
  hashSecret,
  repositoryPrefixOf,
  secretMatchesHash,
} from "@restow/core";
import { fileShareRuns, fileShares, storageGenerationSql, tenants } from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { DeniedThrottle } from "../../lib/denied-audit.js";
import {
  buildRunResticRoute,
  processLocalLocks,
  type RunResticAccess,
  type RunResticResolution,
} from "../../lib/restic-run-route.js";
import type { ProblemError } from "../../problem.js";
import { authFailures } from "../endpoints/agent-auth.js";
import { tenantStorage } from "../endpoints/repository.js";
import { storageSwitchedDuringRun } from "../pve/repository.js";
import { searchedTargets, storeTarget, tenantChunkStore } from "../pve/store.js";
import { admitUpload } from "../run-size/guards.js";
import { runSizeGuards } from "../run-size/instance.js";
import { FILE_SHARE_RUNNER_AUDIT_ACTIONS } from "./constants.js";
import {
  addShareUsage,
  noteShareQuotaRefusal,
  shareLockRegistry,
  shareRemaining,
} from "./usage.js";

/**
 * /internal/file-shares/restic/:shareId: the restic REST backend of the file share
 * runners (docs/FILESHARES.md 5.3). Only the runners reach it, over the internal
 * `runners` network: Caddy never forwards /internal (and answers 404 for it as a
 * second fence), and a request that carries a proxy header is refused here.
 *
 * The credential is the run's own (`<runId>:<token>`, 5.1): a backup run gets the
 * append-only `agent` principal on its own share's repository, a restore run the
 * read-only `reader` principal on the repository of the share it restores from.
 * Repositories live under `file-shares/<shareId>/` of the tenant's primary target.
 *
 * The credential is a row of `file_share_runs` (`token_hash`, `token_expires_at`,
 * valid while the run is starting or running and its tenant active), the lock files
 * a backup writes are recorded in `file_share_repository_locks`, uploads are counted
 * into `file_shares.repository_bytes` and refused when the share's or the tenant's
 * budget is used up (7.4), and refusals of the authorization matrix are audited as
 * `file_share.repository.denied`.
 */

export const FILE_SHARE_RESTIC_PATH = "/internal/file-shares/restic";

/** The problem of an upload a share's budget refused (5.3, 7.4). */
export const FILE_SHARE_QUOTA_PROBLEM = {
  type: "urn:restow:problem:file-share-quota-exceeded",
  detail: "The storage budget for this file share's backups is used up; the upload was refused.",
};

export { fileShareRepositoryPrefix };

/** What the api knows about a run's credential: a row of file_share_runs. */
export interface FileShareRunCredential {
  runId: string;
  tenantId: string;
  kind: "backup" | "restore";
  /** `starting` and `running` runs hold a valid credential (5.1). */
  status: "queued" | "starting" | "running" | "succeeded" | "warning" | "failed" | "cancelled";
  tenantActive: boolean;
  /** SHA-256 of the token (hashSecret). */
  tokenHash: string;
  expiresAt: Date;
  /** The share whose repository the run reads or writes (a restore: its source). */
  repositoryShareId: string;
  /**
   * That share's recorded repository prefix (a chain begun under a fresh one on write-once
   * storage, docs/STORAGE.md); null or absent: `file-shares/<id>/`.
   */
  repositoryPrefix?: string | null;
  /** The target the run was pinned to when it started (docs/STORAGE.md); null before 0.5.0. */
  storageTarget?: string | null;
  /** The tenant's storage generation now. */
  generation?: string;
}

export interface FileShareRunCredentials {
  lookup(runId: string): Promise<FileShareRunCredential | null>;
}

/** Run credentials in memory, for tests of the route without a database. */
export class MemoryRunCredentials implements FileShareRunCredentials {
  private readonly runs = new Map<string, FileShareRunCredential>();

  /** Register a run with its token (only the hash is kept). */
  issue(input: Omit<FileShareRunCredential, "tokenHash"> & { token: string }): void {
    const { token, ...rest } = input;
    this.runs.set(input.runId, { ...rest, tokenHash: hashSecret(token) });
  }

  /** The finish report ends the credential (5.1). */
  end(runId: string, status: FileShareRunCredential["status"] = "succeeded"): void {
    const run = this.runs.get(runId);
    if (run) {
      run.status = status;
    }
  }

  async lookup(runId: string): Promise<FileShareRunCredential | null> {
    return this.runs.get(runId) ?? null;
  }
}

/**
 * The run credentials in `file_share_runs`, looked up on the installation pool (the tenant is
 * not known before the run is). The dispatcher issues the token when it starts a run (8.2).
 */
export class PgRunCredentials implements FileShareRunCredentials {
  async lookup(runId: string): Promise<FileShareRunCredential | null> {
    const [row] = await providerDb
      .select({
        runId: fileShareRuns.id,
        tenantId: fileShareRuns.tenantId,
        kind: fileShareRuns.kind,
        status: fileShareRuns.status,
        tokenHash: fileShareRuns.tokenHash,
        expiresAt: fileShareRuns.tokenExpiresAt,
        repositoryShareId: fileShareRuns.fileShareId,
        repositoryPrefix: fileShares.repositoryPrefix,
        storageTarget: fileShareRuns.storageTarget,
        tenantStatus: tenants.status,
        generation: sql<string>`${storageGenerationSql(sql`${fileShareRuns.tenantId}`)}`,
      })
      .from(fileShareRuns)
      .innerJoin(tenants, eq(tenants.id, fileShareRuns.tenantId))
      .leftJoin(fileShares, eq(fileShares.id, fileShareRuns.fileShareId))
      .where(eq(fileShareRuns.id, runId))
      .limit(1);
    if (!row?.tokenHash || !row.expiresAt) {
      return null;
    }
    return {
      runId: row.runId,
      tenantId: row.tenantId,
      kind: row.kind,
      status: row.status,
      tenantActive: row.tenantStatus === "active",
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt,
      repositoryShareId: row.repositoryShareId,
      repositoryPrefix: row.repositoryPrefix,
      storageTarget: row.storageTarget,
      generation: row.generation,
    };
  }
}

export const fileShareRunCredentials: FileShareRunCredentials = new PgRunCredentials();

/** Decide what a presented credential may do in the repository of `shareId`. */
export async function resolveFileShareCredential(
  credentials: FileShareRunCredentials,
  storageOf: (tenantId: string) => Promise<StorageBackend>,
  storageFor: FileShareResticRouteDeps["storageFor"],
  presented: { runId: string; token: string },
  shareId: string,
  now: number,
): Promise<RunResticResolution> {
  const run = await credentials.lookup(presented.runId);
  if (
    !run ||
    !secretMatchesHash(presented.token, run.tokenHash) ||
    run.repositoryShareId !== shareId
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (
    (run.status !== "starting" && run.status !== "running") ||
    run.expiresAt.getTime() <= now ||
    !run.tenantActive
  ) {
    return { ok: false, reason: "expired" };
  }
  const resolved = storageFor
    ? await storageFor(run)
    : { storage: await storageOf(run.tenantId), refuseWrites: undefined };
  return {
    ok: true,
    access: {
      tenantId: run.tenantId,
      runId: run.runId,
      runKind: run.kind,
      principal: run.kind === "backup" ? (resolved.refuseWrites ? "closing" : "agent") : "reader",
      prefix: repositoryPrefixOf("file_share", shareId, run.repositoryPrefix),
      storage: resolved.storage,
      ...(resolved.refuseWrites ? { refuseWrites: resolved.refuseWrites } : {}),
    },
  };
}

/**
 * The target a run reads and writes (docs/STORAGE.md, "Runs and storage changes"): the one it
 * was pinned to when the dispatcher started it. A backup whose target stopped being the
 * primary has its writes refused (403, which restic takes as final); a run from before 0.5.0
 * (none recorded) uses the primary, a restore of one the target that holds the repository.
 */
export async function pinnedShareStorage(
  run: FileShareRunCredential,
): Promise<{ storage: StorageBackend; refuseWrites?: ProblemError }> {
  const store = await tenantChunkStore(run.tenantId, Date.now(), run.generation);
  const pinned = run.storageTarget ? storeTarget(store, run.storageTarget) : null;
  if (run.kind === "backup") {
    const switched = Boolean(run.storageTarget) && run.storageTarget !== store.primaryTarget;
    return {
      storage: pinned ?? store.write.primary,
      ...(switched ? { refuseWrites: storageSwitchedDuringRun(403) } : {}),
    };
  }
  if (pinned) {
    return { storage: pinned };
  }
  const prefix = repositoryPrefixOf("file_share", run.repositoryShareId, run.repositoryPrefix);
  for (const target of await searchedTargets(store)) {
    if (await target.backend.head(`${prefix}config`).catch(() => null)) {
      return { storage: target.backend };
    }
  }
  return { storage: store.write.primary };
}

export interface FileShareResticRouteDeps {
  credentials: FileShareRunCredentials;
  storageOf: (tenantId: string) => Promise<StorageBackend>;
  /** The run's own target (pinned when it started); `storageOf` without it. */
  storageFor?: (
    run: FileShareRunCredential,
  ) => Promise<{ storage: StorageBackend; refuseWrites?: ProblemError }>;
  /** The budgets of 7.4 (share and tenant); none without it. */
  remainingBytes?: (access: RunResticAccess, shareId: string) => Promise<number | null>;
  /** The lock registry of a backup run's own locks; process-local without it. */
  locks?: (access: RunResticAccess, shareId: string) => ResticLockRegistry;
  /** Accounting of uploads and deletions. */
  onAllowed?: (
    access: RunResticAccess,
    shareId: string,
    bytes: number,
    action: string,
  ) => void | Promise<void>;
  /** An upload the budget refused. */
  onQuotaExceeded?: (access: RunResticAccess, shareId: string) => void | Promise<void>;
  /** The size and space guard of backup runs (#99); none without it. */
  admitUpload?: (
    access: RunResticAccess,
    shareId: string,
    declaredBytes: number | null,
    resource: ResticResource,
  ) => Promise<{ type: string; detail: string } | null>;
  /** Refusals of the authorization matrix (throttled per run and reason). */
  onDenied: (access: RunResticAccess, shareId: string, details: Record<string, unknown>) => void;
}

export function buildFileShareResticRoutes(deps: FileShareResticRouteDeps) {
  const runLocks = processLocalLocks();
  const throttle = new DeniedThrottle();
  return buildRunResticRoute({
    basePath: FILE_SHARE_RESTIC_PATH,
    param: "shareId",
    realm: "restow-share",
    internalOnly: true,
    resolve: (presented, shareId, now) =>
      resolveFileShareCredential(
        deps.credentials,
        deps.storageOf,
        deps.storageFor,
        presented,
        shareId,
        now,
      ),
    locks: (access, shareId) => (deps.locks ? deps.locks(access, shareId) : runLocks(access.runId)),
    remainingBytes: deps.remainingBytes,
    quotaProblem: FILE_SHARE_QUOTA_PROBLEM,
    admitUpload: deps.admitUpload,
    onAllowed: deps.onAllowed,
    onQuotaExceeded: deps.onQuotaExceeded,
    failures: authFailures,
    audit: (access, shareId, denial) => {
      if (throttle.allow(`${access.runId}:${denial.action}:${denial.reason}`, Date.now())) {
        deps.onDenied(access, shareId, { ...denial });
      }
    },
  });
}

/** The size guard of a share's backup run (features/run-size/guards.ts). */
function shareRunGuard(access: RunResticAccess, shareId: string) {
  return runSizeGuards.forRun({
    tenantId: access.tenantId,
    kind: "file_share",
    objectId: shareId,
    runId: access.runId,
    storage: access.storage,
  });
}

/** The routes app.ts mounts. */
export const fileShareResticRoutes = buildFileShareResticRoutes({
  credentials: fileShareRunCredentials,
  storageOf: async (tenantId) => (await tenantStorage(db, tenantId)).storage,
  storageFor: pinnedShareStorage,
  locks: (access, shareId) =>
    shareLockRegistry({ tenantId: access.tenantId, fileShareId: shareId }),
  remainingBytes: async (access, shareId) =>
    access.principal === "agent"
      ? shareRemaining({ tenantId: access.tenantId, fileShareId: shareId }, access.storage)
      : null,
  admitUpload: (access, shareId, declared) => admitUpload(shareRunGuard(access, shareId), declared),
  onAllowed: async (access, shareId, bytes, action) => {
    const share = { tenantId: access.tenantId, fileShareId: shareId };
    if (action === "write") {
      if (access.principal === "agent" && access.runKind === "backup") {
        shareRunGuard(access, shareId).record(bytes);
      }
      await addShareUsage(share, bytes);
    } else if (action === "delete") {
      await addShareUsage(share, -bytes);
    }
  },
  onQuotaExceeded: (access, shareId) =>
    noteShareQuotaRefusal({ tenantId: access.tenantId, fileShareId: shareId }, Date.now()),
  onDenied: (access, shareId, details) => {
    void audit(db, {
      tenantId: access.tenantId,
      actor: `runner:${access.runId}`,
      actorUserId: null,
      ip: typeof details.ip === "string" ? details.ip : null,
      action: FILE_SHARE_RUNNER_AUDIT_ACTIONS.repositoryDenied,
      target: shareId,
      targetType: "file_share",
      details: {
        runId: access.runId,
        action: details.action,
        type: details.type,
        reason: details.reason,
        method: details.method,
      },
    }).catch(() => undefined);
  },
});
