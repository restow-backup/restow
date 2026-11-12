/**
 * Repository copies (0.5.0, docs/STORAGE.md "restic repositories on copies"): the restic
 * repositories of a tenant's containers (`pve-guests/<id>/`), machines (`endpoints/<id>/`) and
 * file shares (`file-shares/<id>/`) are kept on every copy target too, not only on the primary.
 *
 * For each repository and copy target there is a repository at the same prefix on the copy,
 * created with `restic init --copy-chunker-params` from the primary's repository and with the
 * same repository password, so the read fallback (apps/api endpoints/repository.ts
 * `backendHolding`) opens it when the primary no longer holds the repository. It is filled with
 * `restic copy` of every restore point the server keeps (its records: a container's restore
 * points, a file share's restore points, the snapshots a machine's runs reported) that the copy
 * does not hold yet. restic writes each copied snapshot under an id of its own and keeps the
 * primary's as `original`; reads from a copy look a restore point up by it (core `snapshotIdIn`).
 *
 * Retention on the copy follows the primary's: the restore points the server's retention pruned
 * (containers, file shares) are forgotten on the copy as well, and a machine's copy gets the same
 * grouped retention its primary gets (@restow/core `applyGroupedRetention`, dated by the server's
 * records, never by the agent's clock). A snapshot no record names is neither copied nor
 * forgotten. Holds on suspicion stop forgetting on the copy too. restic forget and prune run under
 * the deletion pass `repository_copy_retention` (storage/deletion-guard.ts): restore mode stops
 * them while copying goes on; on a write-once copy target nothing is deleted and the row says so
 * (`deletions_deferred`), and an Object Lock still in force defers a snapshot like on the primary.
 *
 * After every copy `restic check` reads the structure of the copy; once a week a small sample of
 * its pack data is read back as well (`check --read-data-subset`). The state of each copy is one
 * `repository_copies` row; a copy more than two days behind, or failing as long, raises
 * `storage.copy_behind` once per episode.
 */
import {
  applyGroupedRetention,
  DEFAULT_ENDPOINT_RETENTION,
  deletionDecision,
  REPOSITORY_COPY_MARKER_FILE,
  type RepositoryAccess,
  type ResolvedStorageTarget,
  type ResticSnapshot,
  resticBinary,
  resticCacheBase,
  resticCheck,
  resticCheckStructure,
  resticCopy,
  resticErrorDetail,
  resticForget,
  resticInitCopy,
  resticPrune,
  resticSnapshots,
  splitLockedSnapshots,
  withDeletionPermit,
  withRepository,
  withRepositoryPair,
} from "@restow/core";
import {
  type Database,
  EndpointRepositoryBusyError,
  endpoints,
  fileShareSnapshots,
  pveGuestRepositoryLockKey,
  pveSnapshots,
  type RepositoryCopy,
  type RepositoryCopyState,
  repositoryCopies,
  type SuspicionObjectKind,
  withEndpointRepositoryLock,
} from "@restow/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { recordedSnapshots, tenantTimeZone } from "../endpoints/retention.js";
import { shareLockKey } from "../file-shares/common.js";
import {
  freshTenantStorage,
  PgSecretReader,
  type ResolvedTenantStorage,
  tenantRunner,
  type WorkerRuntime,
  withTenantTx,
} from "../handlers/framework.js";
import { recordDeferredDeletion } from "../handlers/immutability.js";
import { hasActiveMigration } from "../handlers/storage-migration.js";
import {
  type RepositoryOwner,
  tenantRepositoryOwners,
} from "../handlers/storage-migration-restic.js";
import { raiseEvents } from "../reporting.js";
import { loadRetentionHolds, retentionHeld, retentionHoldMode } from "../suspicion/holds.js";

export interface RepositoryCopyDeps {
  /** The application role (Row Level Security). */
  readonly db: Database;
  /** The installation role, for the scan across tenants. */
  readonly providerDb: Database;
  readonly runtime: Pick<
    WorkerRuntime,
    "keyrings" | "storage" | "logger" | "now" | "shutdownSignal"
  >;
  /** How long a copy waits for other work on the primary's repository (tests shorten it). */
  readonly lockWaitMs?: number;
  /** New starts are paused for an update (#46): no copy starts. */
  readonly startsPaused?: () => boolean;
  /** Repositories one pass copies at most ({@link COPIES_PER_PASS}). */
  readonly perPass?: number;
}

/** How often the pass looks for copies that are due (5 minutes). */
export const COPY_PASS_INTERVAL_MS = 5 * 60 * 1000;
/** Every copy is brought up to date at least this often (the daily catch-up). */
export const COPY_CATCH_UP_MS = 24 * 60 * 60 * 1000;
/** A copy whose last attempt failed is tried again after this long (1 hour). */
export const COPY_RETRY_MS = 60 * 60 * 1000;
/** The pack data of a copy is sampled this often (`check --read-data-subset`, weekly). */
export const COPY_DATA_CHECK_MS = 7 * 24 * 60 * 60 * 1000;
/** The sample of pack data the weekly check reads back. */
export const COPY_DATA_CHECK_SUBSET = "2%";
/** A copy behind or failing for longer than this raises `storage.copy_behind` (2 days). */
export const COPY_ALERT_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
/** Repositories one pass copies at most; the rest are due in the next pass. */
export const COPIES_PER_PASS = 25;
/** How long a copy waits for the primary's repository (retention, a check) before a later pass. */
export const COPY_LOCK_WAIT_MS = 30_000;
/** Time limits of the restic calls of one copy. */
const COPY_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 60 * 60 * 1000;
const LIST_TIMEOUT_MS = 10 * 60 * 1000;

/** What a copy says when the copy target holds something else under the repository's prefix. */
export const FOREIGN_REPOSITORY_MESSAGE =
  "the copy target holds files under this repository's prefix that are no repository copy (a retired primary's repository, a part of a split one, or what a cancelled move left); they are left untouched and nothing is copied there";

/** The deletion pass of retention on a copy (storage/deletion-guard.ts). */
export const COPY_RETENTION_PASS = "repository_copy_retention" as const;

/** Why retention on a copy did not delete: the target is write-once, restore mode, a lock. */
export type CopyDeletionsDeferred = "write_once" | "restore_mode" | "locked";

/** Which of a repository's snapshots the server keeps, and which its retention removed. */
export interface CopyDecision {
  /** Snapshot ids (the primary's) the copy should hold. */
  readonly keep: ReadonlySet<string>;
  /** Snapshot ids (the primary's) whose copies are forgotten. */
  readonly remove: ReadonlySet<string>;
}

/** The server's retention of one repository, as the copy follows it. */
export interface CopyPolicy {
  /** Retention of the object is held on suspicion: nothing is forgotten on the copy. */
  readonly held: boolean;
  /** Decide over the snapshot ids present on the primary or the copy (the primary's ids). */
  decide(present: readonly string[]): CopyDecision;
}

function holdKind(kind: RepositoryOwner["kind"]): SuspicionObjectKind {
  return kind === "machine" ? "endpoint" : kind === "container" ? "pve_guest" : "file_share";
}

/**
 * The server's retention of `owner` (see the module comment): containers and file shares by the
 * status of their restore points, machines by their grouped retention over the recorded snapshots.
 */
export async function copyPolicy(
  deps: Pick<RepositoryCopyDeps, "db" | "providerDb">,
  tenantId: string,
  owner: Pick<RepositoryOwner, "kind" | "ownerId">,
  now: Date,
): Promise<CopyPolicy> {
  const mode = await retentionHoldMode(deps.providerDb);
  const holds = await withTenantTx(deps.db, tenantId, (tx) =>
    loadRetentionHolds(tx, {
      tenantId,
      kind: holdKind(owner.kind),
      objectIds: [owner.ownerId],
      now,
      mode,
    }),
  );
  const held = retentionHeld(holds, owner.ownerId);
  if (owner.kind === "container" || owner.kind === "file_share") {
    const rows =
      owner.kind === "container"
        ? await withTenantTx(deps.db, tenantId, (tx) =>
            tx
              .select({ id: pveSnapshots.resticSnapshotId, status: pveSnapshots.status })
              .from(pveSnapshots)
              .where(
                and(
                  eq(pveSnapshots.guestId, owner.ownerId),
                  isNotNull(pveSnapshots.resticSnapshotId),
                ),
              ),
          )
        : await withTenantTx(deps.db, tenantId, (tx) =>
            tx
              .select({
                id: fileShareSnapshots.resticSnapshotId,
                status: fileShareSnapshots.status,
              })
              .from(fileShareSnapshots)
              .where(eq(fileShareSnapshots.fileShareId, owner.ownerId)),
          );
    const keep = new Set<string>();
    const remove = new Set<string>();
    for (const row of rows) {
      if (!row.id) continue;
      (row.status === "pruned" ? remove : keep).add(row.id);
    }
    // A snapshot named by an active point and a pruned one (never expected) is kept.
    for (const id of keep) remove.delete(id);
    return {
      held,
      decide: (present) => ({
        keep: matching(present, keep),
        remove: matching(present, remove),
      }),
    };
  }
  const [endpoint] = await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .select({ settings: endpoints.settings })
      .from(endpoints)
      .where(eq(endpoints.id, owner.ownerId))
      .limit(1),
  );
  const policy = endpoint?.settings.retention ?? DEFAULT_ENDPOINT_RETENTION;
  const zone = await tenantTimeZone(deps, tenantId);
  const reported = await recordedSnapshots(deps, tenantId, owner.ownerId);
  return {
    held,
    decide: (present) => {
      // Dated by the server's records (the end of the reporting run), never by the snapshot's time.
      const dated = new Map<string, Date>();
      for (const record of reported.recorded) {
        if (!record.finishedAt) continue;
        for (const id of present) {
          if (id.startsWith(record.snapshotId)) {
            const before = dated.get(id);
            if (!before || record.finishedAt < before) dated.set(id, record.finishedAt);
          }
        }
      }
      const groups = reported.groups.flatMap((entry) =>
        present
          .filter((id) => id.startsWith(entry.snapshotId))
          .map((id) => ({ snapshotId: id, group: entry.group })),
      );
      const decision = applyGroupedRetention(
        [...dated].map(([id, time]) => ({ id, time })),
        groups,
        policy,
        zone,
      );
      return { keep: new Set(decision.keep), remove: new Set(decision.remove) };
    },
  };
}

/** The ids of `present` that one of `recorded` names (a recorded id may be abbreviated). */
function matching(present: readonly string[], recorded: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of present) {
    if (recorded.has(id)) {
      out.add(id);
      continue;
    }
    for (const short of recorded) {
      if (id.startsWith(short)) {
        out.add(id);
        break;
      }
    }
  }
  return out;
}

/** The repository on one target: what restic needs to open it. */
function accessOn(
  target: ResolvedStorageTarget,
  owner: Pick<RepositoryOwner, "prefix" | "ownerId">,
  password: string,
  role: "primary" | "copy",
): RepositoryAccess {
  return {
    storage: target.backend,
    prefix: owner.prefix,
    repositoryPassword: password,
    // A cache folder of its own: the copy is another repository (its own id and keys).
    repositoryKey: role === "primary" ? owner.ownerId : `${owner.ownerId}.copy`,
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
  };
}

/** The original (the primary's) id of a snapshot on a copy. */
function originalOf(snapshot: Pick<ResticSnapshot, "id" | "original">): string {
  return snapshot.original ?? snapshot.id;
}

/** What one copy of one repository came to. */
export interface CopyResult {
  readonly state: RepositoryCopyState;
  /** Restore points the server keeps that the primary holds. */
  readonly primarySnapshots: number;
  /** Of these, how many the copy lacks after the pass. */
  readonly missingSnapshots: number;
  readonly copied: number;
  readonly forgotten: number;
  /** The newest restore point on the copy (the primary's id). */
  readonly lastSnapshotId: string | null;
  readonly check: { ok: boolean; message: string | null } | null;
  readonly dataChecked: boolean;
  readonly deletionsDeferred: CopyDeletionsDeferred | null;
  readonly error: string | null;
}

/**
 * Bring the copy of one repository on one copy target up to date (see the module comment):
 * create it when it is missing, copy what it lacks, check its structure (and, with `dataCheck`, a
 * sample of its data), and forget there what the server's retention removed. Never deletes
 * anything on the primary. Throws when the primary cannot be read; the caller records that.
 */
export async function syncRepositoryCopy(
  deps: Pick<RepositoryCopyDeps, "db" | "providerDb" | "runtime">,
  input: {
    readonly tenantId: string;
    readonly owner: Pick<RepositoryOwner, "prefix" | "kind" | "ownerId">;
    readonly password: string;
    readonly primary: ResolvedStorageTarget;
    readonly copy: ResolvedStorageTarget;
    readonly dataCheck: boolean;
  },
): Promise<CopyResult> {
  const { tenantId, owner, password, primary, copy } = input;
  const signal = deps.runtime.shutdownSignal;
  const now = deps.runtime.now();
  if (!(await primary.backend.head(`${owner.prefix}config`))) {
    throw new Error("the repository is not on the primary storage target");
  }
  const policy = await copyPolicy(deps, tenantId, owner, now);
  const source = accessOn(primary, owner, password, "primary");
  const destination = accessOn(copy, owner, password, "copy");
  const listing = { signal, noLock: true, timeoutMs: LIST_TIMEOUT_MS };
  // Only a repository the server made as a copy is written to (its marker says so): a retired
  // primary's own repository, the half of a split one or what a cancelled move left under the
  // prefix is never filled, forgotten or pruned here.
  const markerKey = `${owner.prefix}${REPOSITORY_COPY_MARKER_FILE}`;
  const hasConfig = (await copy.backend.head(`${owner.prefix}config`)) !== null;
  if ((await copy.backend.head(markerKey)) === null) {
    const foreign = (await copy.backend.list(owner.prefix)).filter(
      (key) => !key.startsWith(`${owner.prefix}locks/`),
    );
    if (foreign.length > 0) {
      throw new Error(FOREIGN_REPOSITORY_MESSAGE);
    }
    await copy.backend.put(
      markerKey,
      Buffer.from(`${JSON.stringify({ version: 1, kind: "repository_copy", createdAt: now })}\n`),
    );
  }
  const copiedPass = await withRepositoryPair(
    source,
    destination,
    async (session, sourceSession) => {
      if (!hasConfig) {
        // Same password, the primary's chunker parameters: deduplication works as on the primary.
        await resticInitCopy(session);
      }
      const onPrimary = await resticSnapshots(sourceSession, listing);
      const onCopy = await resticSnapshots(session, listing);
      const present = [...new Set([...onPrimary.map((s) => s.id), ...onCopy.map(originalOf)])];
      const decision = policy.decide(present);
      const held = new Set(onCopy.map(originalOf));
      const wanted = onPrimary.filter((snapshot) => decision.keep.has(snapshot.id));
      // Oldest first: an interrupted pass leaves the copy with a gapless older part.
      const toCopy = wanted
        .filter((snapshot) => !held.has(snapshot.id))
        .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
        .map((snapshot) => snapshot.id);
      // A copy that stops half way (the target fills up, the connection drops) leaves the
      // snapshots it finished: the lag is counted afterwards, and the reason is kept.
      let copyError: string | null = null;
      if (toCopy.length > 0) {
        try {
          await resticCopy(session, toCopy, { signal, timeoutMs: COPY_TIMEOUT_MS });
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          copyError = resticErrorDetail(error, 500);
        }
      }
      const after = toCopy.length > 0 ? await resticSnapshots(session, listing) : onCopy;
      const nowHeld = new Set(after.map(originalOf));
      const missing = wanted.filter((snapshot) => !nowHeld.has(snapshot.id)).length;
      let check: CopyResult["check"];
      try {
        await resticCheckStructure(session, { signal });
        check = { ok: true, message: null };
      } catch (error) {
        check = { ok: false, message: resticErrorDetail(error, 500) };
      }
      let dataChecked = false;
      if (input.dataCheck && check.ok) {
        try {
          await resticCheck(session, COPY_DATA_CHECK_SUBSET, {
            signal,
            noLock: true,
            timeoutMs: CHECK_TIMEOUT_MS,
          });
          dataChecked = true;
        } catch (error) {
          check = { ok: false, message: resticErrorDetail(error, 500) };
        }
      }
      // Nothing is forgotten on a copy the pass could not bring up to date.
      const forget =
        policy.held || copyError !== null
          ? []
          : after.filter(
              (snapshot) => decision.remove.has(originalOf(snapshot)) && snapshot.original,
            );
      const newest = [...after].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))[0];
      return {
        copied: toCopy.length - missing,
        copyError,
        primarySnapshots: wanted.length,
        missing,
        check,
        dataChecked,
        forget: forget.map((snapshot) => snapshot.id),
        lastSnapshotId: newest ? originalOf(newest) : null,
      };
    },
  );
  const retention =
    copiedPass.forget.length > 0
      ? await retainOnCopy(deps, { tenantId, owner, copy, password, ids: copiedPass.forget })
      : { forgotten: 0, deferred: null };
  const state: RepositoryCopyState =
    copiedPass.copyError !== null || !copiedPass.check?.ok
      ? "failed"
      : copiedPass.missing > 0
        ? "behind"
        : "current";
  return {
    state,
    primarySnapshots: copiedPass.primarySnapshots,
    missingSnapshots: copiedPass.missing,
    copied: copiedPass.copied,
    forgotten: retention.forgotten,
    lastSnapshotId: copiedPass.lastSnapshotId,
    check: copiedPass.check,
    dataChecked: copiedPass.dataChecked,
    deletionsDeferred: retention.deferred,
    error:
      copiedPass.copyError ??
      (copiedPass.check?.ok ? null : `restic check: ${copiedPass.check?.message ?? ""}`),
  };
}

/**
 * Forget `ids` (the copy's own snapshot ids) on the copy and prune it: under the deletion pass
 * `repository_copy_retention`, which restore mode refuses; never on a write-once copy target; a
 * snapshot the storage still locks stays for a later pass. The prune follows the one policy for
 * a target short of space (@restow/core `resticPrune`).
 */
export async function retainOnCopy(
  deps: Pick<RepositoryCopyDeps, "db" | "runtime">,
  input: {
    readonly tenantId: string;
    readonly owner: Pick<RepositoryOwner, "prefix" | "ownerId">;
    readonly copy: ResolvedStorageTarget;
    readonly password: string;
    readonly ids: readonly string[];
  },
): Promise<{ forgotten: number; deferred: CopyDeletionsDeferred | null }> {
  const { tenantId, copy } = input;
  if (copy.writeOnce) {
    return { forgotten: 0, deferred: "write_once" };
  }
  const decision = await deletionDecision({ pass: COPY_RETENTION_PASS, tenantId });
  if (!decision.allowed) {
    deps.runtime.logger.warn("repository copy retention held: deleting is paused", {
      tenantId,
      prefix: input.owner.prefix,
      reason: decision.reason,
    });
    return { forgotten: 0, deferred: "restore_mode" };
  }
  // A deletion the copy target refuses because of Object Lock or the deletion delay is recorded,
  // so the renewal lets it run out (docs/STORAGE.md, "Immutable backups").
  const access: RepositoryAccess = {
    ...accessOn(copy, input.owner, input.password, "copy"),
    onDeletionDeferred: (key, retainUntil) =>
      recordDeferredDeletion(deps.db, tenantId, copy.backend, key, retainUntil),
  };
  const signal = deps.runtime.shutdownSignal;
  // The listener is opened inside the permit: restic's deletes through it carry the permit.
  return withDeletionPermit({ pass: COPY_RETENTION_PASS, tenantId }, () =>
    withRepository(access, async (session) => {
      const split = await splitLockedSnapshots(copy.backend, input.owner.prefix, input.ids);
      if (split.remove.length > 0) {
        await resticForget(session, split.remove, { signal });
        await resticPrune(session, { signal, storage: copy.backend });
      }
      return {
        forgotten: split.remove.length,
        deferred: split.locked.length > 0 ? ("locked" as const) : null,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/** The key of a row: one repository on one copy target. */
function rowKey(prefix: string, targetId: string): string {
  return `${targetId}\u0000${prefix}`;
}

/** Whether the copy of a repository is due (see the module comment). */
export function copyDue(
  row: Pick<RepositoryCopy, "lastAttemptAt" | "state"> | undefined,
  newestBackup: Date | null,
  now: Date,
): boolean {
  if (!row?.lastAttemptAt) {
    return true;
  }
  const since = now.getTime() - row.lastAttemptAt.getTime();
  if (row.state === "failed") {
    return since >= COPY_RETRY_MS;
  }
  // After each successful backup run of the object (many runs between two passes: one copy).
  if (newestBackup && newestBackup > row.lastAttemptAt) {
    return true;
  }
  return since >= COPY_CATCH_UP_MS;
}

/** When each object of the tenant last got a restore point the server recorded. */
async function newestBackups(deps: RepositoryCopyDeps, tenantId: string) {
  const rows = await withTenantTx(deps.db, tenantId, (tx) =>
    tx.execute<{ owner: string; at: Date | string | null }>(sql`
      SELECT endpoint_id AS owner, max(finished_at) AS at FROM endpoint_runs
       WHERE tenant_id = ${tenantId} AND snapshot_id IS NOT NULL GROUP BY endpoint_id
      UNION ALL
      SELECT guest_id AS owner, max(created_at) AS at FROM pve_snapshots
       WHERE tenant_id = ${tenantId} AND restic_snapshot_id IS NOT NULL GROUP BY guest_id
      UNION ALL
      SELECT file_share_id AS owner, max(created_at) AS at FROM file_share_snapshots
       WHERE tenant_id = ${tenantId} GROUP BY file_share_id`),
  );
  const out = new Map<string, Date>();
  for (const row of rows.rows) {
    if (row.at) out.set(String(row.owner), new Date(row.at));
  }
  return out;
}

/** The lock of the primary's repository the server's own work takes (shared: reads only). */
function lockKeyOf(owner: Pick<RepositoryOwner, "kind" | "ownerId">): string {
  return owner.kind === "machine"
    ? owner.ownerId
    : owner.kind === "container"
      ? pveGuestRepositoryLockKey(owner.ownerId)
      : shareLockKey(owner.ownerId);
}

/** What a pass did. */
export interface CopyPassSummary {
  copied: number;
  current: number;
  failed: number;
  forgotten: number;
  alerts: number;
}

/** The tenants with a restic repository, or with rows of repositories that are gone. */
async function tenantsWithRepositories(deps: RepositoryCopyDeps): Promise<string[]> {
  const rows = await deps.providerDb.execute<{ tenant_id: string }>(sql`
    SELECT tenant_id FROM endpoints WHERE repository_secret_id IS NOT NULL
    UNION SELECT tenant_id FROM pve_guests
     WHERE repository_ready_at IS NOT NULL AND repository_secret_id IS NOT NULL
    UNION SELECT tenant_id FROM file_shares
     WHERE repository_ready_at IS NOT NULL AND repository_secret_id IS NOT NULL
    UNION SELECT tenant_id FROM repository_copies`);
  return rows.rows.map((row) => String(row.tenant_id));
}

/**
 * One pass over every tenant: keep the rows in step with the repositories and copy targets, copy
 * what is due (at most {@link COPIES_PER_PASS} repositories), and raise the alerts.
 */
export async function repositoryCopyPass(deps: RepositoryCopyDeps): Promise<CopyPassSummary> {
  const summary: CopyPassSummary = { copied: 0, current: 0, failed: 0, forgotten: 0, alerts: 0 };
  const budget = { left: deps.perPass ?? COPIES_PER_PASS };
  for (const tenantId of await tenantsWithRepositories(deps)) {
    if (deps.runtime.shutdownSignal.aborted) break;
    try {
      await tenantCopies(deps, tenantId, budget, summary);
    } catch (error) {
      // One tenant's fault (its storage, its data) never keeps the others from their copies.
      deps.runtime.logger.warn("repository copies: a tenant could not be handled", {
        tenantId,
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    }
  }
  return summary;
}

async function tenantCopies(
  deps: RepositoryCopyDeps,
  tenantId: string,
  budget: { left: number },
  summary: CopyPassSummary,
): Promise<void> {
  const run = tenantRunner(deps.db, tenantId);
  const storage = (await freshTenantStorage(
    run,
    deps.runtime.storage,
    tenantId,
  )) as Partial<ResolvedTenantStorage>;
  const targets = storage.targets ?? [];
  const primary = targets.find((target) => target.id === storage.primaryTarget);
  const copies = targets.filter((target) => target.role === "copy");
  const owners = (await tenantRepositoryOwners(run, tenantId)).filter(
    (owner) => owner.created && owner.secretId,
  );
  const wantedKeys = new Set(
    copies.flatMap((copy) => owners.map((owner) => rowKey(owner.prefix, copy.id))),
  );
  const rows = await withTenantTx(deps.db, tenantId, (tx) =>
    tx.select().from(repositoryCopies).where(eq(repositoryCopies.tenantId, tenantId)),
  );
  // A copy target removed, a repository gone (its owner removed): its row goes; what the target
  // held stays there (docs/STORAGE.md, "restic repositories on copies").
  const stale = rows.filter((row) => !wantedKeys.has(rowKey(row.prefix, row.targetId)));
  if (stale.length > 0) {
    await withTenantTx(deps.db, tenantId, async (tx) => {
      for (const row of stale) {
        await tx.delete(repositoryCopies).where(eq(repositoryCopies.id, row.id));
      }
    });
  }
  if (!primary || copies.length === 0 || owners.length === 0) {
    return;
  }
  const now = deps.runtime.now();
  const byKey = new Map(rows.map((row) => [rowKey(row.prefix, row.targetId), row]));
  // Every repository and copy target has a row from the start: "x of y current" counts it.
  const missingRows = copies.flatMap((copy) =>
    owners
      .filter((owner) => !byKey.has(rowKey(owner.prefix, copy.id)))
      .map((owner) => ({
        tenantId,
        prefix: owner.prefix,
        kind: owner.kind,
        ownerId: owner.ownerId,
        targetId: copy.id,
        state: "pending" as const,
        troubleSince: now,
      })),
  );
  if (missingRows.length > 0) {
    await withTenantTx(deps.db, tenantId, (tx) =>
      tx.insert(repositoryCopies).values(missingRows).onConflictDoNothing(),
    );
  }
  const migrating = await hasActiveMigration(run, tenantId);
  if (!migrating && deps.startsPaused?.() !== true) {
    const newest = await newestBackups(deps, tenantId);
    const due = copies
      .flatMap((copy) => owners.map((owner) => ({ copy, owner })))
      .map((entry) => ({ ...entry, row: byKey.get(rowKey(entry.owner.prefix, entry.copy.id)) }))
      .filter((entry) => copyDue(entry.row, newest.get(entry.owner.ownerId) ?? null, now))
      .sort(
        (a, b) => (a.row?.lastAttemptAt?.getTime() ?? 0) - (b.row?.lastAttemptAt?.getTime() ?? 0),
      );
    const passwords = new Map<string, string | null>();
    const keys = await deps.runtime.keyrings.get(tenantId);
    const secrets = new PgSecretReader(run, tenantId, keys);
    for (const { copy, owner, row } of due) {
      if (budget.left <= 0 || deps.runtime.shutdownSignal.aborted) break;
      budget.left--;
      if (!passwords.has(owner.ownerId)) {
        passwords.set(owner.ownerId, await secrets.get(owner.secretId as string));
      }
      const password = passwords.get(owner.ownerId);
      await copyOne(
        deps,
        { tenantId, owner, copy, primary, password: password ?? null, row },
        summary,
      );
    }
  }
  summary.alerts += await alertCopiesBehind(deps, tenantId, owners, targets);
}

/** Copy one repository to one copy target and record the outcome. */
async function copyOne(
  deps: RepositoryCopyDeps,
  input: {
    tenantId: string;
    owner: RepositoryOwner;
    copy: ResolvedStorageTarget;
    primary: ResolvedStorageTarget;
    password: string | null;
    row: RepositoryCopy | undefined;
  },
  summary: CopyPassSummary,
): Promise<void> {
  const { tenantId, owner, copy, row } = input;
  const startedAt = deps.runtime.now();
  let result: CopyResult;
  try {
    if (!input.password) {
      throw new Error("the repository password is not stored");
    }
    const password = input.password;
    const dataCheck =
      !row?.lastDataCheckAt ||
      startedAt.getTime() - row.lastDataCheckAt.getTime() >= COPY_DATA_CHECK_MS;
    result = await withEndpointRepositoryLock(
      deps.db.$client,
      lockKeyOf(owner),
      { mode: "shared", waitMs: deps.lockWaitMs ?? COPY_LOCK_WAIT_MS, pollMs: 1000 },
      () =>
        syncRepositoryCopy(deps, {
          tenantId,
          owner,
          password,
          primary: input.primary,
          copy,
          dataCheck,
        }),
    );
  } catch (error) {
    if (error instanceof EndpointRepositoryBusyError) {
      // Retention or a check holds the primary's repository: a later pass, nothing recorded.
      return;
    }
    const message = resticErrorDetail(error, 500);
    deps.runtime.logger.warn("repository copy failed", {
      tenantId,
      prefix: owner.prefix,
      targetId: copy.id,
      errorMessage: message,
    });
    summary.failed++;
    await withTenantTx(deps.db, tenantId, (tx) =>
      tx
        .update(repositoryCopies)
        .set({
          state: "failed",
          lastAttemptAt: startedAt,
          lastError: message,
          troubleSince: sql`coalesce(${repositoryCopies.troubleSince}, ${startedAt})`,
        })
        .where(
          and(
            eq(repositoryCopies.tenantId, tenantId),
            eq(repositoryCopies.prefix, owner.prefix),
            eq(repositoryCopies.targetId, copy.id),
          ),
        ),
    );
    return;
  }
  summary.copied += result.copied;
  summary.forgotten += result.forgotten;
  if (result.state === "current") summary.current++;
  if (result.state === "failed") summary.failed++;
  const finishedAt = deps.runtime.now();
  const current = result.state === "current";
  await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .update(repositoryCopies)
      .set({
        state: result.state,
        primarySnapshots: result.primarySnapshots,
        missingSnapshots: result.missingSnapshots,
        lastSnapshotId: result.lastSnapshotId,
        lastCopiedAt: finishedAt,
        lastAttemptAt: startedAt,
        lastError: result.error,
        lastForgotten: result.forgotten,
        deletionsDeferred: result.deletionsDeferred,
        ...(result.check
          ? {
              lastCheckAt: finishedAt,
              lastCheckOk: result.check.ok,
              lastCheckMessage: result.check.message,
            }
          : {}),
        ...(result.dataChecked ? { lastDataCheckAt: finishedAt } : {}),
        troubleSince: current
          ? null
          : sql`coalesce(${repositoryCopies.troubleSince}, ${startedAt})`,
        ...(current ? { alertedAt: null } : {}),
      })
      .where(
        and(
          eq(repositoryCopies.tenantId, tenantId),
          eq(repositoryCopies.prefix, owner.prefix),
          eq(repositoryCopies.targetId, copy.id),
        ),
      ),
  );
}

/**
 * `storage.copy_behind` for every copy behind, failing or not made for longer than
 * {@link COPY_ALERT_AFTER_MS}: once per episode (`alerted_at`, cleared when it is current again).
 */
export async function alertCopiesBehind(
  deps: Pick<RepositoryCopyDeps, "db" | "runtime">,
  tenantId: string,
  owners: readonly Pick<RepositoryOwner, "prefix" | "kind" | "ownerId" | "name">[],
  targets: readonly Pick<ResolvedStorageTarget, "id" | "name">[],
): Promise<number> {
  const now = deps.runtime.now();
  const threshold = new Date(now.getTime() - COPY_ALERT_AFTER_MS);
  return withTenantTx(deps.db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(repositoryCopies)
      .where(
        and(
          eq(repositoryCopies.tenantId, tenantId),
          sql`${repositoryCopies.state} <> 'current'`,
          sql`${repositoryCopies.troubleSince} <= ${threshold}`,
          sql`${repositoryCopies.alertedAt} IS NULL`,
        ),
      );
    if (rows.length === 0) {
      return 0;
    }
    for (const row of rows) {
      const owner = owners.find((entry) => entry.prefix === row.prefix);
      const target = targets.find((entry) => entry.id === row.targetId);
      const objectName = owner?.name ?? row.ownerId;
      const targetName = target?.name ?? row.targetId;
      const reason =
        row.state === "failed"
          ? (row.lastError ?? "copying failed")
          : row.state === "pending"
            ? "not copied yet"
            : `${row.missingSnapshots} restore point(s) missing`;
      await raiseEvents(
        tx,
        [
          {
            tenantId,
            level: "warning",
            event: "storage.copy_behind",
            message: `The copy of the backups of ${objectName} on the copy target ${targetName} has not been current for more than two days: ${reason}. The primary still holds them.`,
            details: {
              objectName,
              kind: row.kind,
              ownerId: row.ownerId,
              prefix: row.prefix,
              targetId: row.targetId,
              targetName,
              state: row.state,
              missingSnapshots: row.missingSnapshots,
              lastCopiedAt: row.lastCopiedAt?.toISOString() ?? null,
              reason: reason.slice(0, 300),
            },
          },
        ],
        now,
      );
      await tx
        .update(repositoryCopies)
        .set({ alertedAt: now })
        .where(eq(repositoryCopies.id, row.id));
    }
    return rows.length;
  });
}

const LOCK_KEY = 0x72636f70; // "rcop"
/** A pass that runs longer than this says so in the log while it runs. */
const PASS_SLOW_MS = 30 * 60 * 1000;

/** Run a pass every few minutes while no other worker does; returns a stop function. */
export function startRepositoryCopies(
  deps: RepositoryCopyDeps,
  intervalMs = COPY_PASS_INTERVAL_MS,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    const client = await deps.providerDb.$client.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [LOCK_KEY],
      );
      if (!rows[0]?.locked) {
        return;
      }
      const startedAt = Date.now();
      const slow = setInterval(() => {
        deps.runtime.logger.warn("repository copy pass is still running", {
          runningMs: Date.now() - startedAt,
        });
      }, PASS_SLOW_MS);
      try {
        const summary = await repositoryCopyPass(deps);
        const fields = { ...summary, durationMs: Date.now() - startedAt };
        if (Object.values(summary).some((value) => value > 0)) {
          deps.runtime.logger.info("repository copy pass", fields);
        } else {
          deps.runtime.logger.debug("repository copy pass", fields);
        }
      } finally {
        clearInterval(slow);
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    } catch (error) {
      deps.runtime.logger.error("repository copy pass failed", {
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    } finally {
      client.release();
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  };
  timer = setTimeout(() => void tick(), 60_000);
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  deps.runtime.shutdownSignal.addEventListener("abort", stop, { once: true });
  return stop;
}
