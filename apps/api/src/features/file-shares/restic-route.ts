import { hashSecret, secretMatchesHash } from "@restow/core";
import type { StorageBackend } from "@restow/core";
import { db } from "../../db.js";
import { DeniedThrottle } from "../../lib/denied-audit.js";
import {
  type RunResticAccess,
  type RunResticResolution,
  buildRunResticRoute,
  processLocalLocks,
} from "../../lib/restic-run-route.js";
import { authFailures } from "../endpoints/agent-auth.js";
import { tenantStorage } from "../endpoints/repository.js";

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
 * Phase A provides the route and the credential lookup behind an interface; the
 * runs themselves (file_share_runs with token_hash and token_expires_at), the
 * persisted lock registry (file_share_repository_locks) and the budgets come with
 * Phase B (docs/FILESHARES.md 17), which replaces {@link fileShareRunCredentials}.
 */

export const FILE_SHARE_RESTIC_PATH = "/internal/file-shares/restic";

/** The problem of an upload a share's budget refused (5.3, 7.4). */
export const FILE_SHARE_QUOTA_PROBLEM = {
  type: "urn:restow:problem:file-share-quota-exceeded",
  detail: "The storage budget for this file share's backups is used up; the upload was refused.",
};

/** The storage prefix of a share's repository. */
export function fileShareRepositoryPrefix(shareId: string): string {
  return `file-shares/${shareId}/`;
}

/** What the api knows about a run's credential (Phase B: a row of file_share_runs). */
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
}

export interface FileShareRunCredentials {
  lookup(runId: string): Promise<FileShareRunCredential | null>;
}

/**
 * The run credentials of this process, in memory.
 * TODO(Phase B, docs/FILESHARES.md 7.1 and 8.2): look the run up in file_share_runs
 * (token_hash, token_expires_at, status, the tenant's status) instead; the dispatcher
 * issues the token when it starts the run. Until then nothing issues credentials
 * outside tests and the Phase A test script, so the route answers 401 to everyone.
 */
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

export const fileShareRunCredentials = new MemoryRunCredentials();

/** Decide what a presented credential may do in the repository of `shareId`. */
export async function resolveFileShareCredential(
  credentials: FileShareRunCredentials,
  storageOf: (tenantId: string) => Promise<StorageBackend>,
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
  return {
    ok: true,
    access: {
      tenantId: run.tenantId,
      runId: run.runId,
      principal: run.kind === "backup" ? "agent" : "reader",
      prefix: fileShareRepositoryPrefix(shareId),
      storage: await storageOf(run.tenantId),
    },
  };
}

export interface FileShareResticRouteDeps {
  credentials: FileShareRunCredentials;
  storageOf: (tenantId: string) => Promise<StorageBackend>;
  /** TODO(Phase B): budgets of 7.4 (share and tenant); none in Phase A. */
  remainingBytes?: (access: RunResticAccess, shareId: string) => Promise<number | null>;
  /** Refusals of the authorization matrix (throttled per run and reason). */
  onDenied: (access: RunResticAccess, shareId: string, details: Record<string, unknown>) => void;
}

export function buildFileShareResticRoutes(deps: FileShareResticRouteDeps) {
  // TODO(Phase B): persist the backup runs' locks (file_share_repository_locks, 5.3), so a
  // restarted api still lets restic release them and maintenance tells them from stale ones.
  const runLocks = processLocalLocks();
  const throttle = new DeniedThrottle();
  return buildRunResticRoute({
    basePath: FILE_SHARE_RESTIC_PATH,
    param: "shareId",
    realm: "restow-share",
    internalOnly: true,
    resolve: (presented, shareId, now) =>
      resolveFileShareCredential(deps.credentials, deps.storageOf, presented, shareId, now),
    locks: (access) => runLocks(access.runId),
    remainingBytes: deps.remainingBytes,
    quotaProblem: FILE_SHARE_QUOTA_PROBLEM,
    failures: authFailures,
    audit: (access, shareId, denial) => {
      if (throttle.allow(`${access.runId}:${denial.action}:${denial.reason}`, Date.now())) {
        deps.onDenied(access, shareId, { ...denial });
      }
    },
  });
}

/**
 * The routes app.ts mounts. Denials are logged (without the token) until Phase B writes
 * them to the tenant's audit log as `file_share.repository.denied` (5.3, 9.2), together
 * with the action's labels (Phase C, with the glossary rows of section 1).
 */
export const fileShareResticRoutes = buildFileShareResticRoutes({
  credentials: fileShareRunCredentials,
  storageOf: async (tenantId) => (await tenantStorage(db, tenantId)).storage,
  onDenied: (access, shareId, details) => {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "file share runner refused",
        tenantId: access.tenantId,
        runId: access.runId,
        shareId,
        ...details,
      }),
    );
  },
});
