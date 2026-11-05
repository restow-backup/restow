import { createHash } from "node:crypto";
/**
 * Server-side work for Proxmox VE guests (docs/PVE.md, docs/PROXMOX.md 3):
 *
 *   plan       due PVE jobs become backup tasks for the node that hosts each guest
 *   stale      runs that never ended (48 hours) fail; their staged chunk references go;
 *              a backup run its node no longer lists in its heartbeat closes at once (#46);
 *              a restore, restore check or boot test run whose task is over, or a restore
 *              without a task whose access to the repository expired, fails as well
 *   retention  restore points beyond the job's keep rules are pruned: their chunk
 *              references are released (garbage collection takes the chunks later),
 *              their manifest deleted, a container's restic snapshot forgotten; nothing
 *              of a guest held on suspicion (suspicion/holds.ts)
 *   verify     the restore points a check was asked for, oldest request first: every new
 *              one right after its backup (an installation setting, on by default) and
 *              the one an admin asked for (also an older one); and weekly the newest
 *              restore point of every guest. A sample of its data blocks is read back from
 *              storage and compared with the SHA-256 in its map (containers: restic check
 *              of a 5 % subset, without a lock). A bounded number per pass, and no new one
 *              after VERIFY_PASS_BUDGET_MS. Never while the guest has a run going or a backup
 *              its node took on; a check that could not run (stopped, timed out, could not
 *              start) is tried again later, and after two hours reads "could not check"
 *              (attention), never "failed". Runs last in the pass.
 *   test       monthly restore check where a job asks for one: restore into the
 *              restore pool, check, delete (needs capacity, off by default)
 *   boot       boot tests where a job asks for them (weekly, or after every backup): the
 *              guest's node restores the newest restore point to a temporary guest, starts
 *              it and waits for the guest agent; only nodes that announced the capability,
 *              one per node at a time, never beside a backup on the node; a failed or
 *              unproven boot test raises boot_test.failed / boot_test.unproven once; a skip
 *              that passes, or an error, is tried again (30 minutes, doubling, five times),
 *              and boot tests that came to no result for longer than the schedule allows
 *              raise boot_test.skipped once
 *   tokens     an existing PVE API token an admin gave for an enrollment is deleted
 *              once that enrollment token is used, revoked or expired
 *   downloads  prepared ZIP downloads of container files go an hour after they expired
 *
 * One pass every five minutes, in one worker at a time (a session advisory lock). Each step on
 * its own: one that fails is logged and the others still run. Every restic call has a time
 * limit, so no step holds the pass (and with it the planning of backups) for good.
 */
import {
  applyRetentionPolicy,
  type BlockMap,
  ChunkReader,
  DEFAULT_SCHEDULE_TIMEZONE,
  decodeBlockMap,
  deleteOnAllTargets,
  deletionDecision,
  INSTALLATION_DEFAULT_TARGET_ID,
  isDeleteRefused,
  isObjectLocked,
  listLockFiles,
  loadManifest,
  lockClockSkews,
  locksToRemove,
  mapChunkIds,
  measureRepositoryBytes,
  PVE_BOOT_TEST_CAPABILITY,
  PVE_BOOT_TEST_MAX_ATTEMPTS,
  PVE_RESTORE_TEST_EVERY_MS,
  PVE_STALE_RUN_MS,
  protectionOnTargets,
  pveBootTestDue,
  pveBootTestOverdueMs,
  pveBootTestPlan,
  pveBootTestRetry,
  pveBootTestTaskParams,
  pveDisksOf,
  pveGuestCounted,
  pveNextRunAt,
  pveNodeDeclares,
  pveRestoreCheckBlocker,
  pveRestorePointPrivileged,
  pveSelfBackupBlocked,
  ResticError,
  removeLockFiles,
  repositoryPrefixOf,
  resticBinary,
  resticCacheBase,
  resticCheck,
  resticErrorDetail,
  resticForget,
  resticLockTime,
  resticPrune,
  resticSnapshots,
  resticUnlock,
  type StorageBackend,
  type StorageTargets,
  sampleDataBlocks,
  storageStaleLocks,
  type TenantKeyring,
  withDeletionPermit,
  withRepository,
} from "@restow/core";
import {
  type Database,
  EndpointRepositoryBusyError,
  PVE_REPOSITORY_REPAIR_FAILED,
  type PveGuest,
  type PveJob,
  type PveSnapshot,
  type PveVerifyNotChecked,
  type PveVerifyResult,
  pveDownloads,
  pveEnrollmentTokens,
  pveGuestRepositoryLockKey,
  pveGuests,
  pveJobs,
  pveNodes,
  pveRunBlocks,
  pveRuns,
  pveSnapshots,
  pveTasks,
  secrets,
  tenants,
  withEndpointRepositoryLock,
} from "@restow/db";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import { processDefaultStorage } from "../default-storage.js";
import {
  freshTenantStorage,
  PgChunkIndex,
  PgSecretReader,
  primaryWriteOnce,
  tenantRunner,
  type WorkerRuntime,
  withTenantTx,
} from "../handlers/framework.js";
import { hasActiveMigration } from "../handlers/storage-migration.js";
import type { TenantTx } from "../progress.js";
import { raiseEvents } from "../reporting.js";
import {
  DEFAULT_RETENTION_HOLD_MODE,
  loadRetentionHolds,
  retentionHeld,
  retentionHoldMode,
} from "../suspicion/holds.js";

export interface PveDeps {
  readonly db: Database;
  readonly providerDb: Database;
  readonly runtime: Pick<
    WorkerRuntime,
    "keyrings" | "storage" | "logger" | "now" | "shutdownSignal"
  >;
  /** How long retention and the check wait for the API's reads of a container repository. */
  readonly repositoryLockWaitMs?: number;
  /** The installation default (tests pin it); the current one without it. */
  readonly installationDefault?: () => Promise<StorageBackend | null>;
  /**
   * New starts are paused for an update (#46): no backup tasks are planned, and retention,
   * verify and restore checks wait; runs that never ended are still closed.
   */
  readonly startsPaused?: () => boolean;
  /** How long one restore check may take (`PVE_CHECK_TIMEOUT_MS`; tests shorten it). */
  readonly checkTimeoutMs?: number;
  /** After how long a pass starts no new restore check (`VERIFY_PASS_BUDGET_MS`). */
  readonly verifyBudgetMs?: number;
}

/** How long the work on a container repository waits for the file restore's reads (#62). */
export const GUEST_REPOSITORY_LOCK_WAIT_MS = 60_000;

/**
 * Run `work` with a container repository to itself (@restow/db
 * `pveGuestRepositoryLockKey`): restic forget and prune, and the check, never
 * overlap the file restore's reads in the API (browse, ZIP downloads), which
 * share the lock. Throws `EndpointRepositoryBusyError` when the reads go on
 * for longer than the wait.
 */
function withGuestRepository<T>(deps: PveDeps, guestId: string, work: () => Promise<T>) {
  return withEndpointRepositoryLock(
    deps.db.$client,
    pveGuestRepositoryLockKey(guestId),
    {
      mode: "exclusive",
      waitMs: deps.repositoryLockWaitMs ?? GUEST_REPOSITORY_LOCK_WAIT_MS,
      pollMs: 1000,
    },
    work,
  );
}

export const PVE_PASS_INTERVAL_MS = 5 * 60 * 1000;
const STALE_RUN_MS = PVE_STALE_RUN_MS;
const VERIFY_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const RESTORE_TEST_EVERY_MS = PVE_RESTORE_TEST_EVERY_MS;
const TASK_TTL_MS = 12 * 60 * 60 * 1000;
const VERIFY_SAMPLE = 8;
/** Asked-for restore checks per pass (after a backup round they drain over a few passes). */
export const VERIFY_REQUESTED_PER_PASS = 20;
/** Weekly checks per pass, so the asked-for ones never starve them. */
export const VERIFY_PERIODIC_PER_PASS = 10;
/** Without a job's own rules: 7 daily, 4 weekly, 6 monthly. */
export const DEFAULT_PVE_RETENTION = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 };
const LOCK_KEY = 0x70766530; // "pve0"

/**
 * Time limits of the server's restic on a container repository. A storage that keeps failing
 * a deletion lets restic try again for a quarter of an hour per file; without a limit one
 * repository would hold the pass for hours (a container on a write-once share: `restic unlock`
 * still running after 50 minutes, nothing else checked or planned meanwhile).
 */
export const PVE_UNLOCK_TIMEOUT_MS = 2 * 60 * 1000;
/** A restore check (5 % of the data) that takes longer is stopped and tried again later. */
export const PVE_CHECK_TIMEOUT_MS = 60 * 60 * 1000;
const PVE_FORGET_TIMEOUT_MS = 15 * 60 * 1000;
const PVE_PRUNE_TIMEOUT_MS = 60 * 60 * 1000;
/** `restic snapshots` and reading a lock's own time (`restic cat lock`). */
const PVE_LIST_TIMEOUT_MS = 10 * 60 * 1000;
/** A pass starts no new restore check after this long; the rest waits for the next pass. */
export const VERIFY_PASS_BUDGET_MS = 20 * 60 * 1000;
/** A pass that runs longer than this is reported while it runs (with the step it is in). */
const PASS_SLOW_MS = 2 * PVE_PASS_INTERVAL_MS;

export interface PvePassSummary {
  tasks: number;
  staleRuns: number;
  pruned: number;
  verified: number;
  restoreTests: number;
  bootTests: number;
  bootTestAlerts: number;
  pveTokensDropped: number;
  downloadsPurged: number;
}

async function chunkContext(deps: PveDeps, tenantId: string) {
  const keys: TenantKeyring = await deps.runtime.keyrings.get(tenantId);
  const storage: StorageTargets = await deps.runtime.storage.get(tenantId);
  const index = new PgChunkIndex(tenantRunner(deps.db, tenantId), tenantId);
  return { keys, storage, index, reader: new ChunkReader({ storage, keys, index }) };
}

async function readAll(reader: ChunkReader, ids: readonly string[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of reader.read(ids)) {
    parts.push(part);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** The guests a job covers: its members, and for an "all" job every guest in no job. */
export function coveredBy(
  job: Pick<PveJob, "id" | "scopeAll">,
  guests: readonly PveGuest[],
): PveGuest[] {
  // The same rule as every overview (pveJobOfGuest in @restow/core), for one job.
  return guests.filter(
    (g) => pveGuestCounted(g) && (g.jobId === job.id || (job.scopeAll && g.jobId === null)),
  );
}

export async function planJobs(deps: PveDeps, now: Date): Promise<number> {
  const due = await deps.providerDb
    .select({ job: pveJobs })
    .from(pveJobs)
    .innerJoin(tenants, eq(tenants.id, pveJobs.tenantId))
    .where(
      and(eq(pveJobs.enabled, true), lte(pveJobs.nextRunAt, now), eq(tenants.status, "active")),
    );
  let created = 0;
  for (const { job } of due) {
    created += await withTenantTx(deps.db, job.tenantId, async (tx) => {
      const guests = await tx.select().from(pveGuests);
      const nodes = await tx.select().from(pveNodes).where(isNull(pveNodes.revokedAt));
      let n = 0;
      for (const guest of coveredBy(job, guests)) {
        // The Restow server's own VM is backed up only once an admin confirmed it (docs/PVE.md).
        if (pveSelfBackupBlocked(guest)) {
          continue;
        }
        const node = nodes.find((x) => x.clusterId === guest.clusterId && x.name === guest.node);
        if (!node) {
          continue;
        }
        const [open] = await tx
          .select({ id: pveTasks.id })
          .from(pveTasks)
          .where(
            and(
              eq(pveTasks.guestId, guest.id),
              eq(pveTasks.kind, "backup"),
              inArray(pveTasks.status, ["pending", "delivered"]),
            ),
          )
          .limit(1);
        if (open) {
          continue;
        }
        await tx.insert(pveTasks).values({
          tenantId: job.tenantId,
          nodeId: node.id,
          guestId: guest.id,
          kind: "backup",
          params: {
            vmid: guest.vmid,
            mode: job.settings.mode ?? "snapshot",
            verifyRead: false,
            jobId: job.id,
          },
          expiresAt: new Date(now.getTime() + TASK_TTL_MS),
        });
        n++;
      }
      const schedule = job.schedule ?? {
        kind: "daily" as const,
        timeZone: DEFAULT_SCHEDULE_TIMEZONE,
      };
      await tx
        .update(pveJobs)
        .set({
          lastRunAt: now,
          nextRunAt: pveNextRunAt(schedule, new Date(now.getTime() + 60_000), now),
        })
        .where(eq(pveJobs.id, job.id));
      return n;
    });
  }
  return created;
}

// ---------------------------------------------------------------------------
// Stale runs
// ---------------------------------------------------------------------------

/** What `closeRun` needs of a run. */
const closeRunColumns = {
  id: pveRuns.id,
  tenantId: pveRuns.tenantId,
  kind: pveRuns.kind,
  snapshotId: pveRuns.snapshotId,
  taskId: pveRuns.taskId,
};

export async function closeStaleRuns(deps: PveDeps, now: Date): Promise<number> {
  const stale = await deps.providerDb
    .select(closeRunColumns)
    .from(pveRuns)
    .where(
      and(
        eq(pveRuns.status, "running"),
        lt(pveRuns.startedAt, new Date(now.getTime() - STALE_RUN_MS)),
      ),
    );
  let closed = 0;
  for (const run of stale) {
    if (
      await closeRun(
        deps,
        run,
        now,
        "The run never reported its end (node restarted or unreachable).",
      )
    ) {
      closed++;
    }
  }
  return closed;
}

/** A node's list of its runs counts while it is this fresh (heartbeats come every minute). */
const ACTIVE_RUNS_FRESH_MS = 15 * 60 * 1000;
/** A run the node does not list yet is not closed before this: it may have just opened. */
const ACTIVE_RUNS_GRACE_MS = 10 * 60 * 1000;

/**
 * Backup runs their node no longer works on (#46): restow-pve 0.4.0 and later lists the
 * runs it works on in every heartbeat (`facts.activeRuns`). A running backup run of the
 * node that a fresh heartbeat does not list, and that started well before it, has ended
 * without its report reaching the server (the helper restarted, the report was lost
 * while the server was being updated). It is closed now instead of after 48 hours, the
 * same way: succeeded when its restore point was committed, else failed. Nodes with an
 * older helper send no list and keep the 48 hours.
 */
export async function closeRunsNodesDropped(deps: PveDeps, now: Date): Promise<number> {
  const fresh = new Date(now.getTime() - ACTIVE_RUNS_FRESH_MS).toISOString();
  const dropped = await deps.providerDb
    .select(closeRunColumns)
    .from(pveRuns)
    .innerJoin(pveNodes, eq(pveNodes.id, pveRuns.nodeId))
    .where(
      and(
        eq(pveRuns.status, "running"),
        eq(pveRuns.kind, "backup"),
        sql`jsonb_typeof(${pveNodes.facts}->'activeRuns') = 'array'`,
        sql`(${pveNodes.facts}->>'activeRunsAt')::timestamptz > ${fresh}::timestamptz`,
        sql`${pveRuns.startedAt} < (${pveNodes.facts}->>'activeRunsAt')::timestamptz - make_interval(secs => ${ACTIVE_RUNS_GRACE_MS / 1000})`,
        sql`NOT ((${pveNodes.facts}->'activeRuns') ? (${pveRuns.id}::text))`,
      ),
    );
  let closed = 0;
  for (const run of dropped) {
    if (
      await closeRun(
        deps,
        run,
        now,
        "The node no longer works on this run, but its end never reached the server (the helper restarted or the server was unreachable).",
      )
    ) {
      closed++;
    }
  }
  return closed;
}

/** A stop requested for a run of a node that has been silent this long ends it: nobody will. */
const CANCEL_SILENT_NODE_MS = 15 * 60 * 1000;

/**
 * Backup runs stopped in the UI whose node has not called since the stop was asked for and is
 * silent for {@link CANCEL_SILENT_NODE_MS} (powered off, unreachable, or the helper is gone):
 * they end `cancelled` now instead of showing "Cancelling" until the 48 hours are over. A node
 * that comes back with the backup still going gets the cancel order with its next heartbeat; the
 * server refuses the run's uploads in any case.
 */
export async function closeCancelledRunsOfSilentNodes(deps: PveDeps, now: Date): Promise<number> {
  const silentSince = new Date(now.getTime() - CANCEL_SILENT_NODE_MS);
  const stuck = await deps.providerDb
    .select(closeRunColumns)
    .from(pveRuns)
    .leftJoin(pveNodes, eq(pveNodes.id, pveRuns.nodeId))
    .where(
      and(
        eq(pveRuns.status, "running"),
        isNotNull(pveRuns.cancelRequestedAt),
        lt(pveRuns.cancelRequestedAt, silentSince),
        or(
          isNull(pveNodes.id),
          isNull(pveNodes.lastSeenAt),
          lt(pveNodes.lastSeenAt, silentSince),
          sql`${pveNodes.lastSeenAt} < ${pveRuns.cancelRequestedAt}`,
        ),
      ),
    )
    .limit(1000);
  let closed = 0;
  for (const run of stuck) {
    if (
      await closeRun(
        deps,
        run,
        now,
        "The backup was cancelled; its node did not answer, so the server ended the run.",
      )
    ) {
      closed++;
    }
  }
  return closed;
}

/** Why a restore, restore check or boot test run the server closed has no result. */
export const PVE_RESULT_NEVER_REPORTED =
  "The node never reported the result (restarted or unreachable).";

/** A run is not called orphaned before this: its task's result may be on its way. */
const ORPHANED_RUN_GRACE_MS = 10 * 60 * 1000;

/** Why the server closed a restore, restore check or boot test run `closeOrphanedRuns` found. */
export const PVE_ORPHANED_RUN_MESSAGE =
  "The node never reported the end of this run; its task is over or it never got access to the repository, so the server ended it.";

/**
 * Restore, restore check and boot test runs that nothing will close any more, so they do not
 * keep their guest busy (`guestBusy`: no restore check) until the 48 hours are over:
 *
 *   - its task is over (done, failed, cancelled) and the run is still open;
 *   - a restore without a task (a container restore the node asked a credential for, e.g. the
 *     restore of a boot test on a node before 0.5.0, or one started in the PVE UI) whose
 *     credential was never issued: it cannot read anything. One with a credential is not
 *     closed when the credential's own 24 hours are over: the credential lives as long as its
 *     open run (@restow/core `pveRunCredentialLive`), so a long restore is still reading, and
 *     closing its run would cut it off. It ends with its report, or as stale after the 48
 *     hours (`closeStaleRuns`); `guestBusy` lets the guest's checks run after two hours;
 *   - such a restore that started during a boot test of the same guest and restore point that
 *     has ended: it was that boot test's restore;
 *   - a restore check or boot test run whose task is gone.
 *
 * Each is closed by `closeRun` like any run whose result never came, with
 * {@link PVE_ORPHANED_RUN_MESSAGE}: it fails (cancelled when it was stopped in the UI), never
 * succeeds, a boot test gets the outcome `error`, and a task of it still open is closed with it.
 * Runs the API already closed with their task (an expired or lost task, `finishFailedTaskRun`)
 * are not running any more and are not touched. Runs left open by an earlier version heal on
 * the first pass after the update.
 */
export async function closeOrphanedRuns(deps: PveDeps, now: Date): Promise<number> {
  const settled = new Date(now.getTime() - ORPHANED_RUN_GRACE_MS);
  const orphaned = await deps.providerDb
    .select(closeRunColumns)
    .from(pveRuns)
    .where(
      and(
        eq(pveRuns.status, "running"),
        inArray(pveRuns.kind, ["restore", "restore_test", "boot_test"]),
        lt(pveRuns.startedAt, settled),
        or(
          sql`EXISTS (SELECT 1 FROM ${pveTasks} t
            WHERE t.id = ${pveRuns.taskId} AND t.status NOT IN ('pending', 'delivered'))`,
          and(isNull(pveRuns.taskId), inArray(pveRuns.kind, ["restore_test", "boot_test"])),
          and(
            isNull(pveRuns.taskId),
            eq(pveRuns.kind, "restore"),
            or(
              isNull(pveRuns.resticExpiresAt),
              sql`EXISTS (SELECT 1 FROM ${pveRuns} b
                WHERE b.guest_id = ${pveRuns.guestId} AND b.kind = 'boot_test'
                  AND b.snapshot_id = ${pveRuns.snapshotId} AND b.status <> 'running'
                  AND b.started_at <= ${pveRuns.startedAt} AND b.finished_at >= ${pveRuns.startedAt}
                  AND b.finished_at < ${settled})`,
            ),
          ),
        ),
      ),
    )
    .limit(1000);
  let closed = 0;
  for (const run of orphaned) {
    if (await closeRun(deps, run, now, PVE_ORPHANED_RUN_MESSAGE, PVE_ORPHANED_RUN_MESSAGE)) {
      closed++;
    }
  }
  return closed;
}

/**
 * Close a run that is still `running`; what it staged is released. False when it ended
 * meanwhile.
 *
 * Only a backup run can have succeeded: its snapshotId is the restore point it committed. A
 * restore, restore check or boot test names the restore point it reads from the start, so
 * without the node's result it failed (`noResult`, by default {@link PVE_RESULT_NEVER_REPORTED});
 * a boot test gets the outcome `error` (never a rating of the restore point), and the task of
 * such a run is closed with it. A run stopped in the UI ends cancelled. Every path that ends a
 * run the node left open goes through here (stale, dropped, cancelled, orphaned), so the same
 * run always ends the same way, and only once.
 */
async function closeRun(
  deps: PveDeps,
  run: {
    id: string;
    tenantId: string;
    kind: string;
    snapshotId: string | null;
    taskId: string | null;
  },
  now: Date,
  message: string,
  noResult: string = PVE_RESULT_NEVER_REPORTED,
): Promise<boolean> {
  const backup = run.kind === "backup";
  const committed = backup && run.snapshotId !== null;
  const error = backup ? message : noResult;
  const cancelledOrFailed = sql<
    "failed" | "cancelled"
  >`CASE WHEN ${pveRuns.cancelRequestedAt} IS NOT NULL THEN 'cancelled' ELSE 'failed' END`;
  const staged = await withTenantTx(deps.db, run.tenantId, async (tx) => {
    const [updated] = await tx
      .update(pveRuns)
      .set({
        status: committed ? "succeeded" : run.kind === "boot_test" ? "failed" : cancelledOrFailed,
        finishedAt: now,
        errorMessage: committed ? null : error,
        ...(run.kind === "boot_test"
          ? {
              // The same record as a boot test the node could not carry out (API boot-tests.ts).
              stats: sql`${pveRuns.stats} || jsonb_build_object('bootTest', ${JSON.stringify({
                outcome: "error",
                reason: "node_error",
                message: error,
                checkedAt: now.toISOString(),
                durationMs: 0,
                bootSeconds: null,
                guestAgent: false,
                tempVmid: null,
                storage: null,
                cleanedUp: false,
                runId: run.id,
              })}::jsonb)`,
            }
          : {}),
      })
      .where(and(eq(pveRuns.id, run.id), eq(pveRuns.status, "running")))
      .returning({ id: pveRuns.id });
    if (!updated) {
      return null;
    }
    if (!backup && run.taskId) {
      await tx
        .update(pveTasks)
        .set({
          status: sql<
            "failed" | "cancelled"
          >`CASE WHEN ${pveTasks.cancelRequestedAt} IS NOT NULL THEN 'cancelled' ELSE 'failed' END`,
          finishedAt: now,
          errorMessage: error,
        })
        .where(
          and(eq(pveTasks.id, run.taskId), inArray(pveTasks.status, ["pending", "delivered"])),
        );
    }
    const rows = await tx
      .delete(pveRunBlocks)
      .where(eq(pveRunBlocks.runId, run.id))
      .returning({ chunks: pveRunBlocks.chunks });
    return rows.flatMap((r) => r.chunks);
  });
  if (staged === null) {
    return false;
  }
  if (staged.length > 0) {
    await new PgChunkIndex(tenantRunner(deps.db, run.tenantId), run.tenantId).releaseReferences(
      staged,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Every chunk reference a restore point holds: config objects, maps and the blocks they list. */
async function referencesOf(
  ctx: Awaited<ReturnType<typeof chunkContext>>,
  snap: PveSnapshot,
): Promise<string[]> {
  const manifest = await loadManifest(ctx.storage, snap.manifestPath, ctx.keys);
  const ids = new Set<string>();
  for (const object of manifest.objects) {
    for (const id of object.chunks) {
      ids.add(id);
    }
  }
  for (const disk of pveDisksOf(manifest)) {
    const map: BlockMap = decodeBlockMap(await readAll(ctx.reader, disk.object.chunks));
    for (const id of mapChunkIds(map)) {
      ids.add(id);
    }
  }
  return [...ids];
}

async function guestRepositoryPassword(deps: PveDeps, guest: PveGuest): Promise<string | null> {
  if (!guest.repositorySecretId) {
    return null;
  }
  const keys = await deps.runtime.keyrings.get(guest.tenantId);
  return new PgSecretReader(tenantRunner(deps.db, guest.tenantId), guest.tenantId, keys).get(
    guest.repositorySecretId,
  );
}

export async function pruneSnapshot(deps: PveDeps, snap: PveSnapshot, now: Date): Promise<void> {
  const ctx = await chunkContext(deps, snap.tenantId);
  const refs = await referencesOf(ctx, snap);
  // Marked pruned first: nothing builds on it or restores it from here on.
  const marked = await withTenantTx(deps.db, snap.tenantId, async (tx) => {
    const [row] = await tx
      .update(pveSnapshots)
      .set({ status: "pruned", prunedAt: now })
      .where(and(eq(pveSnapshots.id, snap.id), eq(pveSnapshots.status, "active")))
      .returning();
    if (row?.resticSnapshotId) {
      // Its restic snapshot is forgotten by the next comparison of the repository.
      await tx
        .update(pveGuests)
        .set({ repositoryReconciledAt: null })
        .where(eq(pveGuests.id, snap.guestId));
    }
    if (row) {
      await appendAuditEntry(tx, {
        tenantId: snap.tenantId,
        actor: "system",
        action: "pve.snapshot.pruned",
        target: snap.id,
        targetType: "pve_snapshot",
        details: { archiveName: snap.archiveName, sequence: snap.sequence },
      });
    }
    return Boolean(row);
  });
  if (!marked) {
    return;
  }
  await ctx.index.releaseReferences(refs);
  await withDeletionPermit({ pass: "pve_retention", tenantId: snap.tenantId }, () =>
    deleteOnAllTargets(ctx.storage, snap.manifestPath as string, deps.runtime.logger),
  );
}

/** A restic snapshot no restore point names is forgotten once it is this old (6 hours). */
export const PVE_ORPHAN_SNAPSHOT_GRACE_MS = 6 * 60 * 60 * 1000;
/** Each container repository is compared with its restore points at least this often. */
export const PVE_RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
/** Comparisons that were not caused by a prune, per pass (after an update they drain). */
export const PVE_RECONCILES_PER_PASS = 10;
/** How long forget and prune wait for another run's lock before the pass leaves them. */
export const PVE_FORGET_RETRY_LOCK = "2m";
/**
 * A comparison that did not get through (the storage is down, a long restore holds the lock,
 * the password is wrong) is tried again after this long (1 hour), not on every pass: each try
 * waits up to {@link PVE_FORGET_RETRY_LOCK} inside the repository lock and would slow the
 * whole PVE pass. A restore point pruned meanwhile makes it due at once.
 */
export const PVE_RECONCILE_RETRY_MS = 60 * 60 * 1000;

/**
 * VMIDs a restore check or boot test must not take (the API's pve/vmids.ts, docs/PVE.md, "A VMID
 * used again"): those of absent guests Restow keeps with restore points or a job.
 */
async function avoidVmids(
  tx: { execute: Database["execute"] },
  clusterId: string,
): Promise<number[]> {
  const rows = await tx.execute<{ vmid: number }>(sql`
    SELECT DISTINCT g.vmid FROM pve_guests g
     WHERE g.cluster_id = ${clusterId} AND g.present = false
       AND (g.job_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM pve_snapshots s WHERE s.guest_id = g.id AND s.status <> 'pruned'))
     ORDER BY g.vmid LIMIT 1000`);
  return rows.rows.map((r) => Number(r.vmid));
}

/** Whether a run of the guest is going or its node took on a backup of it (`guestBusy`). */
async function guestIsBusy(deps: PveDeps, guestId: string, now: Date): Promise<boolean> {
  const rows = await deps.providerDb.execute<{ busy: boolean }>(
    sql`SELECT ${guestBusy(sql`${guestId}::uuid`, now)} AS busy`,
  );
  return rows.rows[0]?.busy === true;
}

export async function applyRetention(deps: PveDeps, now: Date): Promise<number> {
  const guests = await deps.providerDb.select().from(pveGuests);
  const mode = guests.length > 0 ? await retentionHoldMode(deps.providerDb) : null;
  let pruned = 0;
  // Comparisons of a repository that no prune caused, so far in this pass.
  const reconciles = { count: 0 };
  // A "move" storage migration copies the containers' repositories file by file: retention
  // waits for it, so no restic file it listed is pruned away under it (per tenant, once a run).
  const migrating = new Map<string, boolean>();
  for (const guest of guests) {
    try {
      pruned += await retainGuest(deps, guest, now, mode, migrating, reconciles);
    } catch (error) {
      // One guest's fault (its tenant's data, its storage) never keeps the others from retention.
      deps.runtime.logger.warn("pve retention: a guest could not be handled", {
        guestId: guest.id,
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    }
  }
  return pruned;
}

/** Tenants whose write-once primary this process already logged (once each, not every pass). */
const retentionWriteOnceTold = new Set<string>();

/** Retention of one guest (see `applyRetention`); how many restore points it pruned. */
async function retainGuest(
  deps: PveDeps,
  guest: PveGuest,
  now: Date,
  mode: Awaited<ReturnType<typeof retentionHoldMode>> | null,
  migrating: Map<string, boolean>,
  reconciles: { count: number },
): Promise<number> {
  let busy = migrating.get(guest.tenantId);
  if (busy === undefined) {
    busy = await hasActiveMigration(tenantRunner(deps.db, guest.tenantId), guest.tenantId);
    migrating.set(guest.tenantId, busy);
  }
  if (busy) {
    return 0;
  }
  // Write-once storage (docs/STORAGE.md, "Write-once storage"): nothing there can be deleted, so
  // no restore point is pruned (each stays restorable, its data stays anyway), no restic snapshot
  // forgotten, no prune run. The guest page and the job say so.
  if (primaryWriteOnce(await deps.runtime.storage.get(guest.tenantId))) {
    if (!retentionWriteOnceTold.has(guest.tenantId)) {
      retentionWriteOnceTold.add(guest.tenantId);
      deps.runtime.logger.info(
        "pve retention: not applied, the primary storage target of the tenant is write-once",
        { tenantId: guest.tenantId },
      );
    }
    return 0;
  }
  // Restore mode after restoring a database dump (docs/STORAGE.md): no restore point is pruned
  // and no restic snapshot forgotten; the restored database lacks every backup made after the
  // dump, and the comparison would take their restic snapshots for orphans after 6 hours.
  const deletions = await deletionDecision({ pass: "pve_retention", tenantId: guest.tenantId });
  if (!deletions.allowed) {
    return 0;
  }
  // A backup, restore, check or boot test of the guest runs (its restic holds or takes the
  // repository's lock, a backup builds on the newest restore point): a later pass.
  if (await guestIsBusy(deps, guest.id, now)) {
    return 0;
  }
  const result = await withTenantTx(deps.db, guest.tenantId, async (tx) => {
    const holds = await loadRetentionHolds(tx, {
      tenantId: guest.tenantId,
      kind: "pve_guest",
      objectIds: [guest.id],
      now,
      mode: mode ?? DEFAULT_RETENTION_HOLD_MODE,
    });
    if (retentionHeld(holds, guest.id)) {
      // Held on suspicion: no restore point goes, so no chunk reference is released either,
      // and no restic snapshot is forgotten.
      return null;
    }
    const snaps = await tx
      .select()
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.guestId, guest.id), eq(pveSnapshots.status, "active")));
    const job = guest.jobId
      ? (await tx.select().from(pveJobs).where(eq(pveJobs.id, guest.jobId)).limit(1))[0]
      : undefined;
    const [tenant] = await tx
      .select({ timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.id, guest.tenantId));
    return {
      snaps,
      rules: job?.settings.retention ?? DEFAULT_PVE_RETENTION,
      zone: tenant?.timeZone ?? DEFAULT_SCHEDULE_TIMEZONE,
    };
  });
  if (result === null) {
    return 0;
  }
  let pruned = 0;
  let prunedContainerPoint = false;
  if (result.snaps.length > 1) {
    const decision = applyRetentionPolicy(
      result.snaps.map((s) => ({ id: s.id, time: s.backupAt })),
      result.rules,
      result.zone,
    );
    for (const id of decision.remove) {
      const snap = result.snaps.find((s) => s.id === id) as PveSnapshot;
      try {
        // A restore point the storage still locks stays until a later run (docs/STORAGE.md).
        if (await pveSnapshotLocked(deps, guest, snap)) {
          continue;
        }
        await pruneSnapshot(deps, snap, now);
        pruned++;
        prunedContainerPoint ||= snap.resticSnapshotId !== null;
      } catch (error) {
        deps.runtime.logger.warn("pve retention: could not prune a restore point", {
          snapshotId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  // The restic snapshots of pruned restore points are forgotten by comparing the repository
  // with the restore points: a forget that failed (a lock, the storage, a restart, its time
  // limit) is done by a later pass, and snapshots of runs that never committed go as well.
  const due =
    prunedContainerPoint ||
    (guest.kind === "ct" &&
      guest.repositorySecretId !== null &&
      guest.repositoryReadyAt !== null &&
      (guest.repositoryReconciledAt === null ||
        now.getTime() - guest.repositoryReconciledAt.getTime() >= PVE_RECONCILE_EVERY_MS) &&
      reconciles.count < PVE_RECONCILES_PER_PASS);
  if (!due) {
    return pruned;
  }
  if (!prunedContainerPoint) {
    reconciles.count++;
  }
  await reconcileGuestRepository(deps, guest, now).catch((error) =>
    deps.runtime.logger.warn("pve retention: restic forget failed, tried again next pass", {
      guestId: guest.id,
      error: resticErrorDetail(error, 500),
    }),
  );
  return pruned;
}

/**
 * Compare a container repository with the guest's restore points and forget, then prune, every
 * restic snapshot none of them holds (docs/PVE.md, "Retention"):
 *
 *   - the snapshot of a pruned restore point (also one pruned before 0.5.0, whose forget failed
 *     and was never tried again);
 *   - a snapshot no restore point names at all (a run that wrote it and never committed: a
 *     late cancel, a refused commit, vzdump failing after the archive step) once it is
 *     {@link PVE_ORPHAN_SNAPSHOT_GRACE_MS} old and its `run=` tag names no run still going.
 *
 * Never a snapshot an active (or unavailable) restore point names, nor one the storage still
 * locks. Inside the guest's repository lock, after its stale locks are cleared; forget and
 * prune wait {@link PVE_FORGET_RETRY_LOCK} for another run's lock, and each restic call has its
 * time limit. A storage that refuses to delete a stale lock (write-once: `deletesRefused`) gets
 * no forget and no prune: they take the exclusive lock and delete, so they could only fail and
 * leave one more lock file behind each time; the comparison stays claimed and is tried again
 * after the retry delay. Neither does a repository with a problem (`repositoryProblem`: not
 * complete on the primary, split across targets, a failed repair): it stays claimed as well.
 *
 * The comparison is claimed first: `repositoryReconciledAt` is set to a claim time that makes
 * it due again after {@link PVE_RECONCILE_RETRY_MS}, so a pass that fails is tried again an
 * hour later. Only a pass that got through records the comparison, and only while the column
 * still holds that exact claim: a restore point pruned meanwhile (pruneSnapshot sets it to
 * null) keeps it due, and the next pass forgets that point's snapshot too.
 */
export async function reconcileGuestRepository(
  deps: PveDeps,
  guest: PveGuest,
  now: Date,
): Promise<{ forgotten: string[]; deletesRefused: boolean }> {
  const access = await repositoryAccess(deps, guest);
  if (!access) {
    return { forgotten: [], deletesRefused: false };
  }
  // Restore mode (storage/deletion-guard.ts): nothing is forgotten, the comparison stays due.
  const decision = await deletionDecision({
    pass: "pve_reconcile_forget",
    tenantId: guest.tenantId,
  });
  if (!decision.allowed) {
    deps.runtime.logger.warn("pve retention: restic forget held, deleting is paused", {
      guestId: guest.id,
      reason: decision.reason,
    });
    return { forgotten: [], deletesRefused: false };
  }
  // A restore mode that ended with "keep": restic snapshots without a restore point from before
  // its end stay for good (they may be backups made after the restored dump).
  const keepUnknownBefore = decision.keepUnknownBefore?.getTime() ?? null;
  const storage = await deps.runtime.storage.get(guest.tenantId);
  const targets = [storage.primary, ...storage.copies];
  // Claim the comparison with a value only this pass writes: due again after the retry delay
  // if the pass fails, and set back to null by a prune that lands meanwhile.
  const claim = new Date(now.getTime() - PVE_RECONCILE_EVERY_MS + PVE_RECONCILE_RETRY_MS);
  await withTenantTx(deps.db, guest.tenantId, (tx) =>
    tx.update(pveGuests).set({ repositoryReconciledAt: claim }).where(eq(pveGuests.id, guest.id)),
  );
  // A repository that is not whole on the primary (elsewhere, split, missing, a failed repair)
  // gets no forget and no prune: a prune there would remove data a restore point needs
  // (docs/PVE.md, "Repository problems"). Left claimed: tried again after the retry delay.
  const problem = await repositoryProblem(deps, guest, access);
  if (problem) {
    deps.runtime.logger.warn("pve retention: restic forget skipped", {
      guestId: guest.id,
      problem,
    });
    return { forgotten: [], deletesRefused: false };
  }
  const signal = deps.runtime.shutdownSignal;
  // restic's deletes through the loopback carry this permit.
  const forgotten = await withDeletionPermit(
    { pass: "pve_reconcile_forget", tenantId: guest.tenantId },
    () =>
      withGuestRepository(deps, guest.id, () =>
        withRepository(access, async (session) => {
          // Stale locks only (a run that ended without releasing its lock), as for machines.
          const { deletesRefused } = await clearStaleGuestLocks(deps, access, session, guest.id, {
            unlock: true,
          });
          if (deletesRefused) {
            deps.runtime.logger.warn(
              "pve retention: the storage of a container repository refuses deletes, restic forget and prune are left out",
              { guestId: guest.id },
            );
            return null;
          }
          const listed = await resticSnapshots(session, {
            noLock: true,
            signal,
            timeoutMs: PVE_LIST_TIMEOUT_MS,
          });
          // The restore points and the running runs in one statement, so both come from the same
          // moment: read one after the other, a run committing in between was neither running nor
          // a restore point yet, and the snapshot it just committed was forgotten as an orphan.
          const facts = await withTenantTx(deps.db, guest.tenantId, (tx) =>
            tx.execute<{ source: "point" | "run"; id: string; status: string }>(sql`
          SELECT 'point' AS source, s.restic_snapshot_id AS id, s.status::text AS status
            FROM pve_snapshots s
           WHERE s.guest_id = ${guest.id} AND s.restic_snapshot_id IS NOT NULL
          UNION ALL
          SELECT 'run' AS source, r.id::text AS id, r.status::text AS status
            FROM pve_runs r
           WHERE r.guest_id = ${guest.id} AND r.status = 'running'`),
          );
          const points = facts.rows.filter((r) => r.source === "point");
          const keep = new Set(points.filter((r) => r.status !== "pruned").map((r) => r.id));
          const pruned = new Set(points.filter((r) => r.status === "pruned").map((r) => r.id));
          const runningIds = new Set(facts.rows.filter((r) => r.source === "run").map((r) => r.id));
          const ids: string[] = [];
          for (const snapshot of listed) {
            if (keep.has(snapshot.id)) {
              continue;
            }
            if (!pruned.has(snapshot.id)) {
              // No restore point names it: a run that never committed. Only once it is old, and
              // never while its run (or any run whose tag it carries) still goes.
              const time = Date.parse(snapshot.time);
              const run = snapshot.tags.find((tag) => tag.startsWith("run="))?.slice(4);
              if (
                !Number.isFinite(time) ||
                now.getTime() - time < PVE_ORPHAN_SNAPSHOT_GRACE_MS ||
                (run !== undefined && runningIds.has(run)) ||
                (keepUnknownBefore !== null && time < keepUnknownBefore)
              ) {
                continue;
              }
            }
            if (await protectionOnTargets(targets, `${access.prefix}snapshots/${snapshot.id}`)) {
              continue;
            }
            ids.push(snapshot.id);
          }
          if (ids.length > 0) {
            await resticForget(session, ids, {
              retryLock: PVE_FORGET_RETRY_LOCK,
              signal,
              timeoutMs: PVE_FORGET_TIMEOUT_MS,
            });
            await resticPrune(session, {
              retryLock: PVE_FORGET_RETRY_LOCK,
              signal,
              timeoutMs: PVE_PRUNE_TIMEOUT_MS,
            });
          }
          return ids;
        }),
      ),
  );
  if (forgotten === null) {
    // Left claimed: tried again after PVE_RECONCILE_RETRY_MS (the storage may allow it by then).
    return { forgotten: [], deletesRefused: true };
  }
  // The prune freed space the restic route never saw: measure the repository again.
  const repositoryBytes =
    forgotten.length > 0 ? await measureRepositoryBytes(access.storage, access.prefix) : null;
  await withTenantTx(deps.db, guest.tenantId, async (tx) => {
    if (repositoryBytes !== null) {
      await tx
        .update(pveGuests)
        .set({ repositoryBytes, repositoryMeasuredAt: deps.runtime.now() })
        .where(eq(pveGuests.id, guest.id));
    }
    await tx
      .update(pveGuests)
      .set({ repositoryReconciledAt: now })
      .where(and(eq(pveGuests.id, guest.id), eq(pveGuests.repositoryReconciledAt, claim)));
  });
  if (forgotten.length > 0) {
    deps.runtime.logger.info("pve retention: restic snapshots forgotten", {
      guestId: guest.id,
      snapshots: forgotten.length,
    });
  }
  return { forgotten, deletesRefused: false };
}

/** Whether a target still locks the restore point's manifest or restic snapshot file. */
async function pveSnapshotLocked(deps: PveDeps, guest: PveGuest, snap: PveSnapshot) {
  const storage = await deps.runtime.storage.get(guest.tenantId);
  const targets = [storage.primary, ...storage.copies];
  const keys = [
    ...(snap.manifestPath ? [snap.manifestPath] : []),
    ...(snap.resticSnapshotId
      ? [`${guestRepositoryPrefix(guest)}snapshots/${snap.resticSnapshotId}`]
      : []),
  ];
  for (const key of keys) {
    if (await protectionOnTargets(targets, key)) {
      return true;
    }
  }
  return false;
}

/**
 * The prefix a container's repository lies under: `pve-guests/<id>/`, or the fresh prefix its
 * current chain began under on write-once storage (`pve_guests.repository_prefix`).
 */
function guestRepositoryPrefix(guest: Pick<PveGuest, "id" | "repositoryPrefix">): string {
  return repositoryPrefixOf("container", guest.id, guest.repositoryPrefix);
}

async function repositoryAccess(deps: PveDeps, guest: PveGuest) {
  const password = await guestRepositoryPassword(deps, guest);
  if (!password) {
    return null;
  }
  // Resolved afresh after a change of the primary (the storage generation), not up to five
  // minutes later (docs/STORAGE.md, "Runs and storage changes").
  const storage = await freshTenantStorage(
    tenantRunner(deps.db, guest.tenantId),
    deps.runtime.storage,
    guest.tenantId,
  );
  return {
    storage: storage.primary,
    prefix: guestRepositoryPrefix(guest),
    repositoryPassword: password,
    repositoryKey: guest.id,
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
    targets: storage.targets ?? [],
  };
}

/** How much a recorded repository problem says: a less specific one never replaces it. */
const PROBLEM_RANK: Record<string, number> = {
  "pve-repository-missing": 1,
  "pve-repository-elsewhere": 2,
  "pve-repository-split": 2,
  [PVE_REPOSITORY_REPAIR_FAILED]: 3,
};

/** The places a container repository may lie besides the primary, the installation default included. */
async function otherPlaces(
  deps: PveDeps,
  access: NonNullable<Awaited<ReturnType<typeof repositoryAccess>>>,
): Promise<{ id: string; name: string | null; backend: StorageBackend }[]> {
  const places = access.targets
    .filter((target) => target.backend !== access.storage)
    .map((target) => ({ id: target.id, name: target.name, backend: target.backend }));
  // After a promotion of 0.4.1 the installation default is no target of the tenant any more,
  // yet it may hold the repository (docs/STORAGE.md): searched as the API does before a backup.
  if (!access.targets.some((target) => target.id === INSTALLATION_DEFAULT_TARGET_ID)) {
    const fallback = deps.installationDefault
      ? await deps.installationDefault().catch(() => null)
      : await processDefaultStorage()
          .current()
          .then((current) => current.targets.primary)
          .catch(() => null);
    if (fallback && fallback !== access.storage && !places.some((p) => p.backend === fallback)) {
      places.push({ id: INSTALLATION_DEFAULT_TARGET_ID, name: null, backend: fallback });
    }
  }
  return places;
}

/**
 * Why the server's restic must not work on a container repository, in words, or null when it
 * may. It may when `config` and a key are on the primary and the snapshot of every active
 * restore point lies there too: a snapshot that lies only on another target is a split
 * repository, and a prune on the primary would delete the data it needs. A repair that failed
 * (`pve-repository-repair-failed`) always refuses. Otherwise the other targets of the tenant and
 * the installation default are searched as the API does before a backup (docs/PVE.md,
 * "Repository problems"), and the guest records the problem, so its page explains it instead of
 * restic's "unable to open config file"; a problem the API recorded that says more (where the
 * repository lies) is not replaced by one that says less.
 */
async function repositoryProblem(
  deps: PveDeps,
  guest: PveGuest,
  access: NonNullable<Awaited<ReturnType<typeof repositoryAccess>>>,
): Promise<string | null> {
  const prefix = access.prefix;
  const [current] = await withTenantTx(deps.db, guest.tenantId, (tx) =>
    tx
      .select({ problem: pveGuests.repositoryProblem })
      .from(pveGuests)
      .where(eq(pveGuests.id, guest.id))
      .limit(1),
  );
  const recorded = current?.problem ?? null;
  if (recorded?.type === PVE_REPOSITORY_REPAIR_FAILED) {
    return "the repository repair could not rebuild the container's repository; retention and the check wait until a repair succeeds or it is reset (see the guest page)";
  }
  const primaryFiles = (await access.storage.list(prefix)).filter(
    (key) => !key.startsWith(`${prefix}locks/`),
  );
  const activePoints = await withTenantTx(deps.db, guest.tenantId, (tx) =>
    tx
      .select({ resticSnapshotId: pveSnapshots.resticSnapshotId })
      .from(pveSnapshots)
      .where(
        and(
          eq(pveSnapshots.guestId, guest.id),
          eq(pveSnapshots.kind, "ct"),
          eq(pveSnapshots.status, "active"),
        ),
      ),
  );
  const places = () => otherPlaces(deps, access);
  const label = (place: { id: string; name: string | null }) =>
    place.id === INSTALLATION_DEFAULT_TARGET_ID ? "installation_default" : (place.name ?? place.id);
  const say = (place: { id: string; name: string | null }) =>
    place.id === INSTALLATION_DEFAULT_TARGET_ID
      ? "the installation default"
      : (place.name ?? "another target");
  let type: string;
  let heldBy: string | null = null;
  let message: string;
  if (
    primaryFiles.includes(`${prefix}config`) &&
    primaryFiles.some((key) => key.startsWith(`${prefix}keys/`))
  ) {
    const onPrimary = new Set(primaryFiles);
    const absent = activePoints
      .map((point) => point.resticSnapshotId)
      .filter((id): id is string => id !== null && !onPrimary.has(`${prefix}snapshots/${id}`));
    if (absent.length === 0) {
      return null;
    }
    // A restore point's snapshot is not on the primary: elsewhere, the repository is split.
    let holder: { id: string; name: string | null } | null = null;
    for (const place of await places()) {
      const held = await place.backend.list(`${prefix}snapshots/`).catch(() => [] as string[]);
      if (absent.some((id) => held.includes(`${prefix}snapshots/${id}`))) {
        holder = place;
        break;
      }
    }
    if (!holder) {
      // Gone everywhere: no other target keeps data a prune could take away from it.
      return null;
    }
    type = "pve-repository-split";
    heldBy = label(holder);
    message = `the snapshots of ${absent.length} restore point(s) lie on ${say(holder)} but not on the primary storage target: the repository is split, and a prune would remove data they need (see the guest page)`;
  } else if (primaryFiles.length > 0) {
    type = "pve-repository-split";
    message =
      "the container's repository on the primary storage target holds data without its config or keys: it is split across targets (see the guest page)";
    for (const place of await places()) {
      const held = await place.backend.list(prefix).catch(() => [] as string[]);
      if (held.some((key) => !key.startsWith(`${prefix}locks/`))) {
        heldBy = label(place);
        break;
      }
    }
  } else {
    type = "pve-repository-missing";
    message =
      "the container's repository is on no storage target of this tenant (see the guest page)";
    for (const place of await places()) {
      const held = (await place.backend.list(prefix).catch(() => [] as string[])).filter(
        (key) => !key.startsWith(`${prefix}locks/`),
      );
      if (held.length === 0) {
        continue;
      }
      heldBy = label(place);
      const complete =
        held.includes(`${prefix}config`) && held.some((key) => key.startsWith(`${prefix}keys/`));
      type = complete ? "pve-repository-elsewhere" : "pve-repository-split";
      message = complete
        ? `the container's repository is not on the primary storage target but on ${say(place)} (see the guest page)`
        : `parts of the container's repository lie on ${say(place)}, without its config (see the guest page)`;
      break;
    }
  }
  // What the API recorded before a backup may say more (it searched the same places, with a
  // run's target): kept unless this pass found as much.
  if (recorded && (PROBLEM_RANK[recorded.type] ?? 0) > (PROBLEM_RANK[type] ?? 0)) {
    return message;
  }
  await withTenantTx(deps.db, guest.tenantId, (tx) =>
    tx
      .update(pveGuests)
      .set({
        repositoryProblem: {
          at: deps.runtime.now().toISOString(),
          type,
          heldBy,
          activePoints: activePoints.length,
        },
      })
      .where(eq(pveGuests.id, guest.id)),
  );
  return message;
}

/**
 * Clear the stale locks of a container repository before the server's restic works on it.
 *
 * A lock file is removed straight from the storage once it is stale by both clocks: the storage
 * received it more than 30 minutes ago, and its own time (restic's timestamp, read with
 * `resticLockTime`) is 30 minutes old as well. One the storage received more than a day ago
 * goes by that time alone (@restow/core `locksToRemove`, `UNREADABLE_LOCK_MS`), so its own time
 * is not read: only the locks of the last day are, one restic process each, and a lock whose
 * own time cannot be read stays until it is a day old. restic writes a fresh lock file (with a
 * new name) every five minutes while it works, so a live run never has such an old one, and a
 * storage whose clock lags never gets a live lock taken away. `restic unlock` alone judges by
 * the time inside the file and did not lift a backup's lock left behind for weeks (CT 113,
 * every check postponed as "repository locked").
 *
 * With `unlock` (forget and prune, which take the exclusive lock) `restic unlock` still runs
 * after, bounded by {@link PVE_UNLOCK_TIMEOUT_MS}, and what it says is logged, not swallowed.
 * A check runs without a lock and needs none.
 *
 * A storage that refuses the deletion (a write-once share: EPERM, or Object Lock) can never
 * lose a lock file: that is logged as such, the locks of the last day are not read (the day-old
 * ones go first, and once their removal is refused nothing else can go either), `restic unlock`
 * is not run (it could only fail the same way), and the result says so (`deletesRefused`), so
 * the caller leaves out what needs the exclusive lock. On such a storage the lock files only
 * grow in number; what is read stays bounded by the last day's. Listing the locks and removing
 * them fail on their own: a listing that failed removes nothing, a removal that failed for
 * another reason is logged.
 */
async function clearStaleGuestLocks(
  deps: PveDeps,
  access: Pick<NonNullable<Awaited<ReturnType<typeof repositoryAccess>>>, "storage" | "prefix">,
  session: Parameters<typeof resticUnlock>[0],
  guestId: string,
  options: { unlock: boolean },
): Promise<{ deletesRefused: boolean }> {
  /** Remove these lock files; true when the storage refuses deletes. */
  const remove = async (names: readonly string[]): Promise<boolean> => {
    if (names.length === 0) {
      return false;
    }
    try {
      await removeLockFiles(access.storage, access.prefix, [...names]);
      deps.runtime.logger.info("pve: stale locks of a container repository removed", {
        guestId,
        locks: names.length,
      });
      return false;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isDeleteRefused(error) || isObjectLocked(error)) {
        deps.runtime.logger.warn(
          "pve: stale locks of a container repository cannot be removed: the storage refuses deletes (write-once storage)",
          { guestId, locks: names.length, errorMessage },
        );
        return true;
      }
      deps.runtime.logger.warn("pve: stale locks of a container repository could not be removed", {
        guestId,
        locks: names.length,
        errorMessage,
      });
      return false;
    }
  };
  let refused = false;
  let stale: string[] = [];
  try {
    const present = await listLockFiles(access.storage, access.prefix);
    const now = deps.runtime.now();
    const judge = { agentLocks: new Set<string>(), agentActive: false, now };
    // Stored more than a day ago: removed by the storage time alone, whatever its own time.
    const dayOld = locksToRemove(present, { ...judge, lockTimes: new Map() });
    refused = await remove(dayOld);
    if (!refused) {
      // Only restow-pve and the server write here, so a lock's own time can be trusted: a lock
      // of the last day is stale only when its storage time and its own time are both 30
      // minutes old. A storage whose clock lags (a NAS on local time as UTC) never gets a live
      // lock taken away. A lock that is still there but could not be read is kept for the next
      // pass (null) until it is a day old; one that is gone meanwhile has nothing left to remove.
      const gone = new Set(dayOld);
      const recent = present.filter((lock) => !gone.has(lock.name));
      const lockTimes = new Map<string, Date | null>();
      const unread: { name: string; detail: string }[] = [];
      for (const lock of storageStaleLocks(recent, now)) {
        const read = await resticLockTime(session, lock.name, {
          signal: deps.runtime.shutdownSignal,
          timeoutMs: PVE_LIST_TIMEOUT_MS,
        });
        if ("time" in read) {
          lockTimes.set(lock.name, read.time);
          continue;
        }
        const stillThere = await access.storage.head(`${access.prefix}locks/${lock.name}`);
        if (!stillThere) {
          continue;
        }
        lockTimes.set(lock.name, null);
        unread.push({ name: lock.name, detail: read.unreadable });
      }
      const skews = lockClockSkews(recent, lockTimes);
      if (skews.length > 0) {
        deps.runtime.logger.warn(
          "pve: the storage time of a container repository's lock and the lock's own time differ by more than 30 minutes (is the storage's clock right?)",
          {
            guestId,
            locks: skews.length,
            skewMinutes: Math.round((skews[0]?.skewMs ?? 0) / 60_000),
          },
        );
      }
      stale = locksToRemove(recent, { ...judge, lockTimes });
      // Said once the judgement is made, so the line tells what happens to the lock: kept for
      // the next pass, or (stored more than a day ago meanwhile) removed by its storage time.
      const removing = new Set(stale);
      for (const lock of unread) {
        deps.runtime.logger.warn(
          removing.has(lock.name)
            ? "pve: the time of a container repository's lock could not be read; it was stored more than a day ago and is removed by its storage time alone"
            : "pve: the time of a container repository's lock could not be read; the lock is kept and judged again by the next pass (removed once it was stored more than a day ago)",
          { guestId, lock: lock.name.slice(0, 12), detail: lock.detail },
        );
      }
    }
  } catch (error) {
    deps.runtime.logger.warn("pve: the locks of a container repository could not be listed", {
      guestId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  if (!refused) {
    refused = await remove(stale);
  }
  if (refused) {
    return { deletesRefused: true };
  }
  if (options.unlock) {
    await resticUnlock(session, {
      signal: deps.runtime.shutdownSignal,
      timeoutMs: PVE_UNLOCK_TIMEOUT_MS,
    }).catch((error: unknown) => {
      deps.runtime.logger.warn("pve: restic unlock failed", {
        guestId,
        detail: resticErrorDetail(error, 500),
      });
    });
  }
  return { deletesRefused: false };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/** Read back a sample of data blocks of a VM restore point and compare their hashes. */
export async function verifySnapshot(
  deps: PveDeps,
  snap: PveSnapshot,
  random: () => number = Math.random,
) {
  const result = {
    checkedAt: deps.runtime.now().toISOString(),
    blocks: 0,
    mismatched: 0,
    errors: [] as string[],
  };
  if (snap.kind === "ct") {
    const [guest] = await withTenantTx(deps.db, snap.tenantId, (tx) =>
      tx.select().from(pveGuests).where(eq(pveGuests.id, snap.guestId)),
    );
    const access = guest ? await repositoryAccess(deps, guest) : null;
    if (!access) {
      result.errors.push("the container repository is not available");
      return result;
    }
    const problem = guest ? await repositoryProblem(deps, guest, access) : null;
    if (problem) {
      result.errors.push(problem);
      return result;
    }
    try {
      await withGuestRepository(deps, snap.guestId, () =>
        withRepository(access, async (session) => {
          // Stale lock files go from the storage (a run that ended without releasing its lock),
          // so the node's next backup does not meet them; restic unlock is not needed here.
          await clearStaleGuestLocks(deps, access, session, snap.guestId, { unlock: false });
          // The restore point's own restic snapshot must be there and be the one its run made:
          // `restic check` only checks the snapshots it finds, so a missing one passes it.
          const missing = await containerSnapshotProblem(
            snap,
            session,
            deps.runtime.shutdownSignal,
          );
          if (missing) {
            result.errors.push(missing);
            return;
          }
          // Without a lock: nothing else writes meanwhile (the server's own repository lock
          // above, and no run of the guest is going, `guestBusy`), and a check never waits for
          // a lock or leaves one behind. On write-once storage, where no lock file is ever
          // removed, a check with a lock could never run, and its own lock would block every
          // later backup. Bounded: a check that takes too long is stopped and tried again.
          await resticCheck(session, "5%", {
            signal: deps.runtime.shutdownSignal,
            noLock: true,
            timeoutMs: deps.checkTimeoutMs ?? PVE_CHECK_TIMEOUT_MS,
          });
        }),
      );
    } catch (error) {
      // Someone reads the repository (file restore), another run holds its lock, or the check
      // was stopped or ran out of time: it did not run, so nothing is known yet (verifyOne
      // tries again later).
      if (
        error instanceof EndpointRepositoryBusyError ||
        checkNotRun(error) !== null ||
        deps.runtime.shutdownSignal.aborted
      ) {
        throw error;
      }
      // What restic said, with the lines that explain it (bounded).
      result.errors.push(resticErrorDetail(error, 1000));
    }
    return result;
  }
  const ctx = await chunkContext(deps, snap.tenantId);
  for (const disk of snap.disks) {
    try {
      const map = decodeBlockMap(await readAll(ctx.reader, disk.map.chunks));
      for (const index of sampleDataBlocks(map, VERIFY_SAMPLE, random)) {
        const entry = map.entries[index];
        if (!entry) {
          continue;
        }
        result.blocks++;
        const data = await readAll(ctx.reader, entry.chunks);
        if (createHash("sha256").update(data).digest("hex") !== entry.sha256) {
          result.mismatched++;
          result.errors.push(`${disk.device}: block ${index} does not match its SHA-256`);
        }
      }
    } catch (error) {
      result.errors.push(
        `${disk.device}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
      );
    }
  }
  return result;
}

/**
 * What is wrong with the restic snapshot a container restore point names, or null when it is
 * there: the repository's snapshot list (from the storage, not restic's local cache, which may
 * still hold a snapshot file the storage lost) must contain it, and its `run=` tag (restow-pve
 * tags every container backup with its run) must name the restore point's run. A list that
 * could not be read for a passing reason (the storage or the network did not answer, restic
 * was stopped) says nothing about the restore point: the check did not run (`interrupted`) and
 * is tried again. Everything else is a finding: a repository that is not there or does not
 * open with its password, a restic that cannot be started (missing, not executable), and any
 * other failure of restic (a damaged config or snapshot file); postponing those would keep the
 * check "not run" until it gives up, without ever saying what is wrong.
 */
async function containerSnapshotProblem(
  snap: Pick<PveSnapshot, "resticSnapshotId" | "runId">,
  session: Parameters<typeof resticSnapshots>[0],
  signal: AbortSignal,
): Promise<string | null> {
  const id = snap.resticSnapshotId;
  if (!id) {
    return "the restore point names no restic snapshot";
  }
  let listed: Awaited<ReturnType<typeof resticSnapshots>>;
  try {
    listed = await resticSnapshots(session, {
      noLock: true,
      signal,
      timeoutMs: PVE_LIST_TIMEOUT_MS,
    });
  } catch (error) {
    if (!resticListTransient(error)) {
      throw error;
    }
    throw new ResticError(
      `the snapshot list of the repository could not be read: ${resticErrorDetail(error, 600)}`,
      error instanceof ResticError ? error.exitCode : null,
      "interrupted",
      error instanceof ResticError ? error.stderr : "",
    );
  }
  const found = listed.find((s) => s.id === id);
  if (!found) {
    return `restic snapshot ${id.slice(0, 8)} of this restore point is not in the repository (unable to load snapshot: not found)`;
  }
  const run = found.tags.find((tag) => tag.startsWith("run="))?.slice(4);
  if (run !== undefined && snap.runId && run !== snap.runId) {
    return `restic snapshot ${id.slice(0, 8)} belongs to run ${run}, not to this restore point's run ${snap.runId}`;
  }
  return null;
}

/**
 * restic's words for a storage or network that did not answer this time (the REST bridge
 * answers 5xx when the storage fails), as opposed to a repository that is broken or missing.
 */
const TRANSIENT_RESTIC =
  /connection (refused|reset)|broken pipe|timed? ?out|deadline exceeded|temporary failure|no such host|network is unreachable|unexpected EOF|server closed|unexpected HTTP response \((5\d\d|429)\)|\b(50[234]|429) /i;

/**
 * Whether a failed `restic snapshots` says nothing about the repository: restic was stopped
 * (also by its time limit), another run held a lock, or the storage or network did not answer. A process that could not
 * be started (ENOENT, EACCES) is not passing; neither is any other failure of restic.
 */
function resticListTransient(error: unknown): boolean {
  if (!(error instanceof ResticError)) {
    return false;
  }
  if (
    error.failure === "killed" ||
    error.failure === "interrupted" ||
    error.failure === "timeout" ||
    error.failure === "locked"
  ) {
    return true;
  }
  if (error.failure !== "other") {
    return false;
  }
  return TRANSIENT_RESTIC.test(`${error.stderr}\n${error.message}`);
}

/**
 * Why a container check did not run at all: the repository's restic lock (exit code 11; a
 * check runs without a lock since 0.5.0, so only an older record says so), or restic was
 * stopped before it finished (a signal, or its time limit, `PVE_CHECK_TIMEOUT_MS`). Neither
 * says anything about the restore point. Null for a real finding (or no restic error).
 */
function checkNotRun(error: unknown): PveVerifyNotChecked["reason"] | null {
  if (!(error instanceof ResticError)) {
    return null;
  }
  if (error.failure === "locked") {
    return "locked";
  }
  return error.failure === "killed" ||
    error.failure === "interrupted" ||
    error.failure === "timeout"
    ? "interrupted"
    : null;
}
/** A check that could not run waits this long before it is tried again. */
export const VERIFY_POSTPONE_MS = 10 * 60 * 1000;
/** After this long without a check that could run, the restore point reads "could not check". */
export const VERIFY_GIVE_UP_MS = 2 * 60 * 60 * 1000;
/** The weekly check of a guest whose check could not run is tried again after a day. */
const VERIFY_AFTER_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** A run older than this is closed as stale anyway (bounds the index range of the busy test). */
const BUSY_RUN_MS = STALE_RUN_MS;
/**
 * A container restore started in the PVE UI keeps the guest busy this long at most: its end may
 * never be reported (an older node), and its restic restore only reads (a check runs without a
 * lock). Its run ends with the node's report, else as stale after the 48 hours its credential
 * lives (`pveRunCredentialLive`, `closeStaleRuns`).
 */
const PVE_RESTORE_BUSY_MS = 2 * 60 * 60 * 1000;

type VerifyOutcome = "checked" | "later" | "postponed" | "not_checked";

/**
 * A check that could not run: kept asked for and tried again after `VERIFY_POSTPONE_MS` (at
 * the back of the queue), the previous result standing meanwhile; after `VERIFY_GIVE_UP_MS`
 * since it was first asked for, recorded as not checked (attention, never "failed", never
 * proof), and the guest's weekly clock tries again after a day.
 */
async function postponeVerify(
  deps: PveDeps,
  snap: PveSnapshot,
  now: Date,
  reason: PveVerifyNotChecked["reason"],
  detail: string,
): Promise<"postponed" | "not_checked"> {
  const { notChecked: earlier, ...previous } = snap.verify ?? {
    blocks: 0,
    mismatched: 0,
    errors: [],
  };
  const pending = earlier && !earlier.gaveUpAt ? earlier : null;
  const since = pending?.since ?? (snap.verifyRequestedAt ?? now).toISOString();
  const notChecked: PveVerifyNotChecked = {
    reason,
    since,
    attempts: (pending?.attempts ?? 0) + 1,
    detail: detail.slice(0, 1000),
  };
  if (now.getTime() - Date.parse(since) < VERIFY_GIVE_UP_MS) {
    // The previous result (if any) stands until a check could run.
    const verify: PveVerifyResult = { ...previous, notChecked };
    await withTenantTx(deps.db, snap.tenantId, (tx) =>
      tx
        .update(pveSnapshots)
        .set({ verify, verifyRequestedAt: new Date(now.getTime() + VERIFY_POSTPONE_MS) })
        .where(eq(pveSnapshots.id, snap.id)),
    );
    deps.runtime.logger.info("pve verify: the check could not run, it is tried again later", {
      snapshotId: snap.id,
      guestId: snap.guestId,
      reason,
      attempts: notChecked.attempts,
      detail: notChecked.detail,
    });
    return "postponed";
  }
  const verify: PveVerifyResult = {
    blocks: 0,
    mismatched: 0,
    errors: [],
    notChecked: { ...notChecked, gaveUpAt: now.toISOString() },
  };
  await withTenantTx(deps.db, snap.tenantId, async (tx) => {
    await tx
      .update(pveSnapshots)
      .set({ verify, verifyRequestedAt: null })
      .where(eq(pveSnapshots.id, snap.id));
    // The weekly clock tries the guest's newest restore point again after a day.
    await tx
      .update(pveGuests)
      .set({ lastVerifyAt: new Date(now.getTime() - VERIFY_EVERY_MS + VERIFY_AFTER_GIVE_UP_MS) })
      .where(and(eq(pveGuests.id, snap.guestId), eq(pveGuests.lastSnapshotId, snap.id)));
  });
  deps.runtime.logger.warn("pve verify: the check could not run, the restore point is unchecked", {
    snapshotId: snap.id,
    guestId: snap.guestId,
    reason,
    attempts: notChecked.attempts,
    detail: notChecked.detail,
  });
  return "not_checked";
}

/**
 * Check one restore point and keep the result (see `VerifyOutcome`). A check that could not
 * start (its repository password, the storage, the tenant's keys) is postponed like one that
 * was stopped, with the reason `error`: it never blocks the queue behind it.
 */
async function verifyOne(deps: PveDeps, snap: PveSnapshot, now: Date): Promise<VerifyOutcome> {
  let verify: Awaited<ReturnType<typeof verifySnapshot>>;
  try {
    verify = await verifySnapshot(deps, snap, Math.random);
  } catch (error) {
    if (error instanceof EndpointRepositoryBusyError) {
      deps.runtime.logger.info("pve verify: the container repository is being read, later", {
        guestId: snap.guestId,
      });
      return "later";
    }
    if (deps.runtime.shutdownSignal.aborted) {
      // Stopped for a shutdown: the next worker checks it.
      return "later";
    }
    const reason = checkNotRun(error) ?? "error";
    if (reason === "error") {
      deps.runtime.logger.warn("pve verify: the check could not start", {
        snapshotId: snap.id,
        guestId: snap.guestId,
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    }
    return postponeVerify(deps, snap, now, reason, resticErrorDetail(error, 1000));
  }
  await withTenantTx(deps.db, snap.tenantId, async (tx) => {
    await tx
      .update(pveSnapshots)
      .set({ verify, verifyRequestedAt: null })
      .where(eq(pveSnapshots.id, snap.id));
    // The weekly clock of the guest counts from a check of its newest restore point.
    await tx
      .update(pveGuests)
      .set({ lastVerifyAt: now })
      .where(and(eq(pveGuests.id, snap.guestId), eq(pveGuests.lastSnapshotId, snap.id)));
  });
  if (verify.errors.length > 0) {
    deps.runtime.logger.warn("pve verify found problems", {
      snapshotId: snap.id,
      errors: verify.errors.slice(0, 5),
    });
  }
  return "checked";
}

/**
 * Whether the guest `guestId` (a column) is busy: a run of it is going (a backup, a restore,
 * a boot test: its restic holds or will take the repository's lock; a restore started in the PVE
 * UI for `PVE_RESTORE_BUSY_MS` at most), or its node took on a backup of it that has not started
 * its run yet. Indexed (pve_runs_guest_started_idx,
 * pve_tasks_open_backup_idx), one probe per candidate row.
 */
function guestBusy(guestId: SQL, now: Date): SQL {
  const runsSince = new Date(now.getTime() - BUSY_RUN_MS);
  const pveRestoreSince = new Date(now.getTime() - PVE_RESTORE_BUSY_MS);
  return sql`(EXISTS (SELECT 1 FROM ${pveRuns} r
      WHERE r.guest_id = ${guestId} AND r.started_at > ${runsSince} AND r.status = 'running'
        AND NOT (r.kind = 'restore' AND r.origin = 'pve' AND r.started_at <= ${pveRestoreSince}))
    OR EXISTS (SELECT 1 FROM ${pveTasks} t
      WHERE t.guest_id = ${guestId} AND t.kind = 'backup' AND t.status = 'delivered'
        AND (t.expires_at IS NULL OR t.expires_at > ${now})))`;
}

/**
 * Whether a restore check of the guest `guestId` (a column) is due now and can run (no run of
 * the guest is going, `guestBusy`): `verifyDue` takes it at the end of this pass. A restore test
 * or boot test is not planned for such a guest before that check: its run counts as going from
 * the moment it is planned (status `running`), so the check would wait until the node has
 * collected, restored and cleaned up the test guest. The test is planned on the next pass, after
 * the check (one that could not run is postponed, so it does not hold the test either).
 */
function checkComesFirst(guestId: SQL, now: Date): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${pveSnapshots} s
      WHERE s.guest_id = ${guestId} AND s.status = 'active' AND s.verify_requested_at <= ${now})
    AND NOT ${guestBusy(guestId, now)})`;
}

/**
 * The restore checks of one pass: first the restore points a check was asked for (exactly those,
 * oldest request first: after a backup, or an admin's "Check now" of any restore point), then
 * the weekly check of each guest's newest restore point. Both bounded per pass, and no new check
 * starts once the pass spent `VERIFY_PASS_BUDGET_MS` on them (the rest waits for the next pass).
 * A guest that is busy (`guestBusy`, asked again right before each check: a backup round may
 * have started meanwhile) is left for a later pass; a check asked for after a backup is due a
 * moment after the commit (`PVE_VERIFY_AFTER_COMMIT_MS`), when the node's restic has let go.
 * One restore point whose check fails in an unexpected way is logged and skipped, never a
 * reason for the others to wait.
 */
export async function verifyDue(deps: PveDeps, now: Date): Promise<number> {
  let n = 0;
  let started = 0;
  const startedAt = Date.now();
  const budget = deps.verifyBudgetMs ?? VERIFY_PASS_BUDGET_MS;
  const outOfTime = () => started > 0 && Date.now() - startedAt >= budget;
  const tryOne = async (snap: PveSnapshot): Promise<VerifyOutcome> => {
    try {
      if (await guestIsBusy(deps, snap.guestId, now)) {
        return "later";
      }
      started++;
      return await verifyOne(deps, snap, now);
    } catch (error) {
      // Recording the outcome failed (the database): logged, and the queue goes on.
      deps.runtime.logger.warn("pve verify: the check could not run", {
        snapshotId: snap.id,
        guestId: snap.guestId,
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
      return "later";
    }
  };
  const requested = await deps.providerDb
    .select()
    .from(pveSnapshots)
    .where(
      and(
        isNotNull(pveSnapshots.verifyRequestedAt),
        lte(pveSnapshots.verifyRequestedAt, now),
        not(guestBusy(sql`${pveSnapshots.guestId}`, now)),
      ),
    )
    .orderBy(asc(pveSnapshots.verifyRequestedAt), asc(pveSnapshots.id))
    .limit(VERIFY_REQUESTED_PER_PASS);
  const tried = new Set<string>();
  for (const snap of requested) {
    if (deps.runtime.shutdownSignal.aborted || outOfTime()) {
      return n;
    }
    if (snap.status !== "active") {
      // Pruned before its check came: nothing left to read.
      await withTenantTx(deps.db, snap.tenantId, (tx) =>
        tx
          .update(pveSnapshots)
          .set({ verifyRequestedAt: null })
          .where(eq(pveSnapshots.id, snap.id)),
      );
      continue;
    }
    tried.add(snap.guestId);
    if ((await tryOne(snap)) === "checked") {
      n++;
    }
  }
  const due = await deps.providerDb
    .select()
    .from(pveGuests)
    .where(
      and(
        sql`${pveGuests.lastSnapshotId} IS NOT NULL`,
        or(
          isNull(pveGuests.lastVerifyAt),
          lt(pveGuests.lastVerifyAt, new Date(now.getTime() - VERIFY_EVERY_MS)),
        ),
        // A check of its newest restore point waits already (asked for, or postponed).
        sql`NOT EXISTS (SELECT 1 FROM ${pveSnapshots} s
          WHERE s.id = ${pveGuests.lastSnapshotId} AND s.verify_requested_at IS NOT NULL)`,
        not(guestBusy(sql`${pveGuests.id}`, now)),
      ),
    )
    .orderBy(sql`${pveGuests.lastVerifyAt} ASC NULLS FIRST`)
    .limit(VERIFY_PERIODIC_PER_PASS);
  for (const guest of due) {
    if (deps.runtime.shutdownSignal.aborted || outOfTime()) {
      return n;
    }
    if (tried.has(guest.id)) {
      continue;
    }
    const [snap] = await withTenantTx(deps.db, guest.tenantId, (tx) =>
      tx
        .select()
        .from(pveSnapshots)
        .where(and(eq(pveSnapshots.guestId, guest.id), eq(pveSnapshots.status, "active")))
        .orderBy(desc(pveSnapshots.sequence))
        .limit(1),
    );
    if (!snap || snap.verifyRequestedAt !== null) {
      continue;
    }
    const outcome = await tryOne(snap);
    if (outcome === "checked") {
      n++;
      // Also when the guest's newest restore point is not `lastSnapshotId` (pruned meanwhile).
      await withTenantTx(deps.db, guest.tenantId, (tx) =>
        tx.update(pveGuests).set({ lastVerifyAt: now }).where(eq(pveGuests.id, guest.id)),
      );
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Monthly restore check
// ---------------------------------------------------------------------------

/**
 * Plan the monthly restore checks the jobs ask for: per job one guest whose check is due, the
 * longest unchecked first, and only one its node can run now (`pveRestoreCheckBlocker`:
 * restores allowed, seen lately), that has no restore or boot test waiting and no run going. A
 * guest passed over is not stamped, so it is planned once its node can; the guest's page says
 * why (`restoreCheck.blocker`). The planned one is stamped now, so a failing check is not
 * planned again on every pass; one the node skipped (target storage missing, inactive, without
 * the guest's content type or too small) is tried again after a day (API node-service.ts).
 */
export async function planRestoreTests(deps: PveDeps, now: Date): Promise<number> {
  const jobs = await deps.providerDb.select().from(pveJobs).where(eq(pveJobs.enabled, true));
  let n = 0;
  for (const job of jobs) {
    const test = job.settings.restoreTest;
    if (!test?.enabled || !test.targetStorage) {
      continue;
    }
    n += await withTenantTx(deps.db, job.tenantId, async (tx) => {
      const due = coveredBy(job, await tx.select().from(pveGuests))
        .filter(
          (g) =>
            g.lastSnapshotId !== null &&
            (g.lastRestoreTestAt === null ||
              g.lastRestoreTestAt.getTime() < now.getTime() - RESTORE_TEST_EVERY_MS),
        )
        .sort(
          (a, b) => (a.lastRestoreTestAt?.getTime() ?? 0) - (b.lastRestoreTestAt?.getTime() ?? 0),
        );
      if (due.length === 0) {
        return 0;
      }
      const nodes = await tx.select().from(pveNodes).where(isNull(pveNodes.revokedAt));
      for (const guest of due) {
        // A container whose repository has a problem recorded (elsewhere, split, missing, a
        // failed repair: `repositoryProblem`, the API before a backup) is not tested: the node's
        // credential would read from the first target that holds a config, a split half, or
        // nothing at all. The guest's page shows the problem; a backup that finds the
        // repository again, or a repair, clears it.
        if (guest.kind === "ct" && guest.repositoryProblem) {
          continue;
        }
        const node =
          nodes.find((x) => x.clusterId === guest.clusterId && x.name === guest.node) ?? null;
        if (pveRestoreCheckBlocker(node, now) !== null || !node) {
          continue;
        }
        const [open] = await tx
          .select({ id: pveTasks.id })
          .from(pveTasks)
          .where(
            and(
              eq(pveTasks.guestId, guest.id),
              inArray(pveTasks.kind, ["restore", "boot_test"]),
              inArray(pveTasks.status, ["pending", "delivered"]),
            ),
          )
          .limit(1);
        if (open) {
          continue;
        }
        // A run of it going, or a backup its node took on (the restore checks' rule).
        const [busy] = await tx
          .select({ id: pveGuests.id })
          .from(pveGuests)
          .where(and(eq(pveGuests.id, guest.id), guestBusy(sql`${pveGuests.id}`, now)))
          .limit(1);
        if (busy) {
          continue;
        }
        // A restore check of the guest that is due runs first (`checkComesFirst`): planned now,
        // this test's run would keep the guest busy and the check waiting until the node is done.
        const [checkFirst] = await tx
          .select({ id: pveGuests.id })
          .from(pveGuests)
          .where(and(eq(pveGuests.id, guest.id), checkComesFirst(sql`${pveGuests.id}`, now)))
          .limit(1);
        if (checkFirst) {
          continue;
        }
        const [snap] = await tx
          .select()
          .from(pveSnapshots)
          .where(eq(pveSnapshots.id, guest.lastSnapshotId as string));
        if (snap?.status !== "active") {
          continue;
        }
        // Restow restores containers only as unprivileged: a restore point of a privileged one
        // is passed over and not counted as checked; the guest's page says so (API
        // guestRestoreCheckFacts, blocker "privileged").
        if (pveRestorePointPrivileged(snap, guest.privileged)) {
          continue;
        }
        const [task] = await tx
          .insert(pveTasks)
          .values({
            tenantId: job.tenantId,
            nodeId: node.id,
            guestId: guest.id,
            kind: "restore",
            params: {
              volname: snap.archiveName,
              kind: snap.kind,
              targetVmid: 0,
              // restow-pve from 0.5.0 picks a free VMID outside these (docs/PVE-PROTOCOL.md).
              avoidVmids: await avoidVmids(tx, guest.clusterId),
              targetStorage: test.targetStorage,
              pool: "restow-restore",
              start: false,
              restoreTest: true,
            },
            expiresAt: new Date(now.getTime() + TASK_TTL_MS),
          })
          .returning();
        await tx.insert(pveRuns).values({
          tenantId: job.tenantId,
          clusterId: guest.clusterId,
          nodeId: node.id,
          guestId: guest.id,
          kind: "restore_test",
          origin: "restow",
          archiveName: snap.archiveName,
          taskId: task?.id ?? null,
          snapshotId: snap.id,
          startedAt: now,
        });
        // Marked now, so a failing test is not planned again on every pass.
        await tx
          .update(pveGuests)
          .set({ lastRestoreTestAt: now })
          .where(eq(pveGuests.id, guest.id));
        return 1;
      }
      return 0;
    });
  }
  return n;
}

// ---------------------------------------------------------------------------
// Boot tests (docs/PVE.md, "Boot test")
// ---------------------------------------------------------------------------

/** The guests whose newest restore point is of a privileged container (pveRestorePointPrivileged). */
async function privilegedNewest(tx: TenantTx, guests: readonly PveGuest[]): Promise<Set<string>> {
  const ids = guests
    .filter((g) => g.kind === "ct" && g.lastSnapshotId !== null)
    .map((g) => g.lastSnapshotId as string);
  if (ids.length === 0) {
    return new Set();
  }
  const points = new Map(
    (
      await tx
        .select({
          id: pveSnapshots.id,
          kind: pveSnapshots.kind,
          guestConfig: pveSnapshots.guestConfig,
        })
        .from(pveSnapshots)
        .where(inArray(pveSnapshots.id, ids))
    ).map((p) => [p.id, p]),
  );
  return new Set(
    guests
      .filter((g) => {
        if (g.kind !== "ct") return false;
        const point = g.lastSnapshotId ? points.get(g.lastSnapshotId) : undefined;
        return point ? pveRestorePointPrivileged(point, g.privileged) : g.privileged;
      })
      .map((g) => g.id),
  );
}

/** A node silent for longer than this gets no new boot test (it would only wait and expire). */
const BOOT_TEST_NODE_SEEN_MS = 10 * 60 * 1000;
/** A boot test waits this long for its node. */
const BOOT_TEST_TASK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Plan the boot tests the jobs ask for: per guest of an enabled job with boot tests on, the newest
 * restore point, when `pveBootTestDue` says so. Only on a node that announced boot tests, allows
 * restores and was seen lately; never on a node that already waits for or runs a boot test, or
 * runs a backup (the node checks again, and skips with the reason).
 */
export async function planBootTests(deps: PveDeps, now: Date): Promise<number> {
  const jobs = await deps.providerDb
    .select({ job: pveJobs })
    .from(pveJobs)
    .innerJoin(tenants, eq(tenants.id, pveJobs.tenantId))
    .where(and(eq(pveJobs.enabled, true), eq(tenants.status, "active")));
  let n = 0;
  for (const { job } of jobs) {
    const plan = pveBootTestPlan(job.settings.bootTest);
    if (plan.schedule === "off") {
      continue;
    }
    n += await withTenantTx(deps.db, job.tenantId, async (tx) => {
      const guests = coveredBy(job, await tx.select().from(pveGuests)).filter(
        (g) => g.lastSnapshotId !== null,
      );
      if (guests.length === 0) {
        return 0;
      }
      const nodes = await tx.select().from(pveNodes).where(isNull(pveNodes.revokedAt));
      const busy = new Set<string>();
      for (const row of await tx
        .select({ nodeId: pveTasks.nodeId })
        .from(pveTasks)
        .where(
          and(eq(pveTasks.kind, "boot_test"), inArray(pveTasks.status, ["pending", "delivered"])),
        )) {
        busy.add(row.nodeId);
      }
      for (const row of await tx
        .select({ nodeId: pveRuns.nodeId })
        .from(pveRuns)
        .where(and(eq(pveRuns.kind, "backup"), eq(pveRuns.status, "running")))) {
        if (row.nodeId) busy.add(row.nodeId);
      }
      let planned = 0;
      for (const guest of guests) {
        const node = nodes.find((x) => x.clusterId === guest.clusterId && x.name === guest.node);
        if (
          !node ||
          busy.has(node.id) ||
          !pveNodeDeclares(node.facts, PVE_BOOT_TEST_CAPABILITY) ||
          node.facts.restoresAllowed === false ||
          !node.lastSeenAt ||
          now.getTime() - node.lastSeenAt.getTime() > BOOT_TEST_NODE_SEEN_MS
        ) {
          continue;
        }
        const [snap] = await tx
          .select()
          .from(pveSnapshots)
          .where(and(eq(pveSnapshots.guestId, guest.id), eq(pveSnapshots.status, "active")))
          .orderBy(desc(pveSnapshots.sequence))
          .limit(1);
        // A restore point of a privileged container is not booted (the guest's page says why:
        // bootTestBlocker "privileged").
        if (!snap || pveRestorePointPrivileged(snap, guest.privileged)) {
          continue;
        }
        // A restore check of the guest that is due runs first (`checkComesFirst`).
        const [checkFirst] = await tx
          .select({ id: pveGuests.id })
          .from(pveGuests)
          .where(and(eq(pveGuests.id, guest.id), checkComesFirst(sql`${pveGuests.id}`, now)));
        if (checkFirst) {
          continue;
        }
        // By guest first: pve_runs_guest_started_idx reads the guest's runs, not every run.
        const attempts = await tx
          .select({ status: pveRuns.status, stats: pveRuns.stats, startedAt: pveRuns.startedAt })
          .from(pveRuns)
          .where(
            and(
              eq(pveRuns.guestId, guest.id),
              eq(pveRuns.kind, "boot_test"),
              eq(pveRuns.snapshotId, snap.id),
            ),
          )
          .orderBy(desc(pveRuns.startedAt))
          .limit(PVE_BOOT_TEST_MAX_ATTEMPTS + 1);
        // A skip that passes (a backup or boot test ran, memory or space was short) and a test
        // the node could not carry out are tried again with a growing wait, a few times; any
        // other outcome stands for this restore point (pveBootTestRetry).
        const retry = pveBootTestRetry(
          attempts.map((a) => {
            const test = a.status === "running" ? null : bootTestOf(a.stats);
            return {
              outcome: typeof test?.outcome === "string" ? test.outcome : null,
              reason: typeof test?.reason === "string" ? test.reason : "",
              startedAt: a.startedAt,
            };
          }),
        );
        const scheduled = pveBootTestDue(
          {
            schedule: plan.schedule,
            lastBootTestAt: guest.lastBootTestAt,
            newest: {
              backupAt: snap.backupAt,
              tested: snap.bootTest !== null || retry.tested || retry.retryAt !== null,
            },
          },
          now,
        );
        const retryDue = !retry.tested && retry.retryAt !== null && retry.retryAt <= now;
        // Weekly: a retry within the week, or the week's test; never before the wait is over.
        if (retry.retryAt !== null && retry.retryAt > now) {
          continue;
        }
        if (!scheduled && !retryDue) {
          continue;
        }
        const [task] = await tx
          .insert(pveTasks)
          .values({
            tenantId: job.tenantId,
            nodeId: node.id,
            guestId: guest.id,
            kind: "boot_test",
            params: {
              ...pveBootTestTaskParams(snap, guest.vmid, plan),
              jobId: job.id,
              avoidVmids: await avoidVmids(tx, guest.clusterId),
            },
            expiresAt: new Date(now.getTime() + BOOT_TEST_TASK_TTL_MS),
          })
          .returning({ id: pveTasks.id });
        await tx.insert(pveRuns).values({
          tenantId: job.tenantId,
          clusterId: guest.clusterId,
          nodeId: node.id,
          guestId: guest.id,
          kind: "boot_test",
          origin: "restow",
          archiveName: snap.archiveName,
          taskId: task?.id ?? null,
          snapshotId: snap.id,
          startedAt: now,
        });
        // Marked now, so a failing test is not planned again on every pass.
        await tx.update(pveGuests).set({ lastBootTestAt: now }).where(eq(pveGuests.id, guest.id));
        busy.add(node.id);
        planned++;
      }
      return planned;
    });
  }
  return n;
}

/** The boot test record of a run's stats, as far as it is one. */
function bootTestOf(stats: Record<string, unknown>): {
  outcome?: unknown;
  reason?: string;
  message?: string;
  skippedAlertedAt?: unknown;
} | null {
  const test = stats.bootTest;
  return test && typeof test === "object" ? (test as Record<string, never>) : null;
}

/** Boot tests older than this are not alerted any more (a worker that was down for long). */
const BOOT_TEST_ALERT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Raise boot_test.failed for a red boot test and boot_test.unproven for a yellow one, once per
 * run (`stats.bootTest.alertedAt`), into the bell and the event rules of the tenant.
 */
export async function alertBootTests(deps: PveDeps, now: Date): Promise<number> {
  const due = await deps.providerDb
    .select({ run: pveRuns, guest: pveGuests })
    .from(pveRuns)
    .innerJoin(pveGuests, eq(pveGuests.id, pveRuns.guestId))
    .where(
      and(
        eq(pveRuns.kind, "boot_test"),
        sql`${pveRuns.status} <> 'running'`,
        sql`${pveRuns.finishedAt} > ${new Date(now.getTime() - BOOT_TEST_ALERT_WINDOW_MS)}`,
        sql`${pveRuns.stats}->'bootTest'->>'outcome' IN ('red', 'yellow')`,
        sql`${pveRuns.stats}->'bootTest'->>'alertedAt' IS NULL`,
      ),
    )
    .limit(200);
  let n = 0;
  for (const { run, guest } of due) {
    const test = run.stats.bootTest as { outcome?: string; reason?: string; message?: string };
    const red = test.outcome === "red";
    const name = guest.name?.trim() || `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`;
    await withTenantTx(deps.db, run.tenantId, async (tx) => {
      await raiseEvents(
        tx,
        [
          {
            tenantId: run.tenantId,
            level: red ? "error" : "warning",
            event: red ? "boot_test.failed" : "boot_test.unproven",
            message: red
              ? `The boot test of ${name} failed: ${test.message ?? ""}`.trim()
              : `The boot test of ${name} has no proof: ${test.message ?? ""}`.trim(),
            details: {
              pveGuestId: guest.id,
              objectName: name,
              snapshotId: run.snapshotId,
              runId: run.id,
              archiveName: run.archiveName,
              reason: test.reason ?? null,
            },
          },
        ],
        now,
      );
      await tx
        .update(pveRuns)
        .set({
          stats: sql`jsonb_set(${pveRuns.stats}, '{bootTest,alertedAt}', to_jsonb(${now.toISOString()}::text))`,
        })
        .where(eq(pveRuns.id, run.id));
    });
    n++;
  }
  return n;
}

/**
 * Raise boot_test.skipped once per guest and episode: its job boot-tests it, but no boot test
 * came to an outcome (green, yellow, red) for longer than the schedule allows (two days after
 * every backup, eight days weekly), and the last attempt was skipped or could not be carried
 * out. A skip the planner still tries again is not yet "no result": the event waits until the
 * attempts at the newest tested restore point are over (a skip that stays, or the attempts used
 * up, `pveBootTestRetry`) or the skips themselves have gone on for that long. Otherwise a guest
 * whose last result is old by the rhythm of its backups (backed up every three days, tested
 * after every backup) would raise it on the first `backup_running` of a new restore point,
 * whose retry 30 minutes later usually succeeds. The event names the last reason; the run it
 * was raised for keeps `skippedAlertedAt`, so it comes again only after a boot test came to an
 * outcome in between.
 */
export async function alertBootTestsSkipped(deps: PveDeps, now: Date): Promise<number> {
  const jobs = await deps.providerDb
    .select({ job: pveJobs })
    .from(pveJobs)
    .innerJoin(tenants, eq(tenants.id, pveJobs.tenantId))
    .where(and(eq(pveJobs.enabled, true), eq(tenants.status, "active")));
  let n = 0;
  for (const { job } of jobs) {
    const overdueMs = pveBootTestOverdueMs(pveBootTestPlan(job.settings.bootTest).schedule);
    if (overdueMs === null) {
      continue;
    }
    n += await withTenantTx(deps.db, job.tenantId, async (tx) => {
      const all = coveredBy(job, await tx.select().from(pveGuests)).filter(
        (g) => g.lastSnapshotId !== null,
      );
      // A guest whose newest restore point is of a privileged container gets no boot test, so
      // none is missing.
      const privileged = await privilegedNewest(tx, all);
      const guests = all.filter((g) => !privileged.has(g.id));
      let raised = 0;
      for (const guest of guests) {
        const rated = (r: { stats: Record<string, unknown> }) => {
          const outcome = bootTestOf(r.stats)?.outcome;
          return outcome === "green" || outcome === "yellow" || outcome === "red";
        };
        // The last boot test that came to a result, and the attempts since.
        const [last] = await tx
          .select({ finishedAt: pveRuns.finishedAt })
          .from(pveRuns)
          .where(
            and(
              eq(pveRuns.guestId, guest.id),
              eq(pveRuns.kind, "boot_test"),
              sql`${pveRuns.stats}->'bootTest'->>'outcome' IN ('green', 'yellow', 'red')`,
            ),
          )
          .orderBy(desc(pveRuns.startedAt))
          .limit(1);
        const episode = (
          await tx
            .select()
            .from(pveRuns)
            .where(
              and(
                eq(pveRuns.guestId, guest.id),
                eq(pveRuns.kind, "boot_test"),
                sql`${pveRuns.status} <> 'running'`,
                last?.finishedAt ? sql`${pveRuns.startedAt} > ${last.finishedAt}` : undefined,
              ),
            )
            .orderBy(desc(pveRuns.startedAt))
            .limit(50)
        ).filter((r) => !rated(r));
        const latest = episode[0];
        const latestOutcome = latest ? bootTestOf(latest.stats)?.outcome : null;
        if (!latest || (latestOutcome !== "skipped" && latestOutcome !== "error")) {
          continue;
        }
        const episodeStart = episode[episode.length - 1]?.startedAt ?? now;
        const since = last?.finishedAt ?? episodeStart;
        if (now.getTime() - since.getTime() < overdueMs) {
          continue;
        }
        // Still being tried: the planner retries this restore point after a passing skip.
        const retry = pveBootTestRetry(
          episode
            .filter((r) => r.snapshotId === latest.snapshotId)
            .map((r) => {
              const test = bootTestOf(r.stats);
              return {
                outcome: typeof test?.outcome === "string" ? test.outcome : null,
                reason: typeof test?.reason === "string" ? test.reason : "",
                startedAt: r.startedAt,
              };
            }),
        );
        if (!retry.tested && now.getTime() - episodeStart.getTime() < overdueMs) {
          continue;
        }
        if (episode.some((r) => typeof bootTestOf(r.stats)?.skippedAlertedAt === "string")) {
          continue;
        }
        const test = bootTestOf(latest.stats) ?? {};
        const name = guest.name?.trim() || `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`;
        const days = Math.floor((now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000));
        await raiseEvents(
          tx,
          [
            {
              tenantId: job.tenantId,
              level: "warning",
              event: "boot_test.skipped",
              message:
                `No boot test of ${name} came to a result for ${days} days: ${test.message || test.reason || ""}`.trim(),
              details: {
                pveGuestId: guest.id,
                objectName: name,
                snapshotId: latest.snapshotId,
                runId: latest.id,
                reason: test.reason ?? null,
                days,
              },
            },
          ],
          now,
        );
        await tx
          .update(pveRuns)
          .set({
            stats: sql`jsonb_set(${pveRuns.stats}, '{bootTest,skippedAlertedAt}', to_jsonb(${now.toISOString()}::text))`,
          })
          .where(eq(pveRuns.id, latest.id));
        raised++;
      }
      return raised;
    });
  }
  return n;
}

// ---------------------------------------------------------------------------
// Existing PVE API tokens handed to an enrollment
// ---------------------------------------------------------------------------

/**
 * Delete the sealed PVE API token of every enrollment token that can no longer
 * hand it over: used by a node (the enrollment deletes it already; this is the
 * second line), revoked or expired. Restow keeps an admin's PVE token only as
 * long as the node may still need it (docs/PVE.md, security).
 */
export async function dropPveTokenSecrets(deps: PveDeps, now: Date): Promise<number> {
  const done = await deps.providerDb
    .select({
      tenantId: pveEnrollmentTokens.tenantId,
      secretId: pveEnrollmentTokens.pveTokenSecretId,
    })
    .from(pveEnrollmentTokens)
    .where(
      and(
        isNotNull(pveEnrollmentTokens.pveTokenSecretId),
        or(
          lte(pveEnrollmentTokens.expiresAt, now),
          isNotNull(pveEnrollmentTokens.revokedAt),
          isNotNull(pveEnrollmentTokens.usedByNodeId),
        ),
      ),
    );
  const byTenant = new Map<string, string[]>();
  for (const row of done) {
    if (row.secretId) {
      byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row.secretId]);
    }
  }
  let n = 0;
  for (const [tenantId, ids] of byTenant) {
    // The reference on the enrollment token goes null with the secret (ON DELETE SET NULL).
    const removed = await withTenantTx(deps.db, tenantId, (tx) =>
      tx.delete(secrets).where(inArray(secrets.id, ids)).returning({ id: secrets.id }),
    );
    n += removed.length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Prepared ZIP downloads of container files (#62)
// ---------------------------------------------------------------------------

/** Prepared downloads are valid for minutes; their rows are kept for an hour more, then go. */
export const DOWNLOAD_KEEP_MS = 60 * 60 * 1000;

export async function purgeDownloads(deps: PveDeps, now: Date): Promise<number> {
  const purged = await deps.providerDb
    .delete(pveDownloads)
    .where(lt(pveDownloads.expiresAt, new Date(now.getTime() - DOWNLOAD_KEEP_MS)))
    .returning({ id: pveDownloads.id });
  return purged.length;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * One pass. Every step runs on its own: one that fails is logged ("pve maintenance step
 * failed") and the others still run. The restore checks come last, so the planning of backups,
 * restore tests and boot tests never waits for them; a test is not planned for a guest whose
 * check is due and can run (`checkComesFirst`), so the check does not wait for the test either.
 * `onStep` is told which step runs.
 */
export async function pvePass(
  deps: PveDeps,
  onStep: (step: string) => void = () => undefined,
): Promise<PvePassSummary> {
  const now = deps.runtime.now();
  const paused = deps.startsPaused?.() === true;
  const step = async (name: string, run: () => Promise<number>, skip = false) => {
    if (skip) {
      return 0;
    }
    onStep(name);
    try {
      return await run();
    } catch (error) {
      deps.runtime.logger.error("pve maintenance step failed", {
        step: name,
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
      return 0;
    }
  };
  const tasks = await step("plan", () => planJobs(deps, now), paused);
  const staleRuns =
    (await step("stale runs", () => closeStaleRuns(deps, now))) +
    (await step("dropped runs", () => closeRunsNodesDropped(deps, now))) +
    (await step("cancelled runs", () => closeCancelledRunsOfSilentNodes(deps, now))) +
    (await step("orphaned runs", () => closeOrphanedRuns(deps, now)));
  const pruned = await step("retention", () => applyRetention(deps, now), paused);
  const restoreTests = await step("restore tests", () => planRestoreTests(deps, now), paused);
  const bootTests = await step("boot tests", () => planBootTests(deps, now), paused);
  const bootTestAlerts =
    (await step("boot test alerts", () => alertBootTests(deps, now))) +
    (await step("boot test skipped alerts", () => alertBootTestsSkipped(deps, now)));
  const pveTokensDropped = await step("tokens", () => dropPveTokenSecrets(deps, now));
  const downloadsPurged = await step("downloads", () => purgeDownloads(deps, now));
  const verified = await step("verify", () => verifyDue(deps, now), paused);
  return {
    tasks,
    staleRuns,
    pruned,
    verified,
    restoreTests,
    bootTests,
    bootTestAlerts,
    pveTokensDropped,
    downloadsPurged,
  };
}

/** Run a pass every few minutes while no other worker does; returns a stop function. */
export function startPveMaintenance(deps: PveDeps, intervalMs = PVE_PASS_INTERVAL_MS): () => void {
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
        deps.runtime.logger.debug("pve maintenance pass skipped: another worker runs one");
        return;
      }
      const startedAt = Date.now();
      let current = "start";
      // A pass that takes far longer than usual says so while it runs, and where it is.
      const slow = setInterval(() => {
        deps.runtime.logger.warn("pve maintenance pass is still running", {
          step: current,
          runningMs: Date.now() - startedAt,
        });
      }, PASS_SLOW_MS);
      try {
        const summary = await pvePass(deps, (step) => {
          current = step;
        });
        const fields = { ...summary, durationMs: Date.now() - startedAt };
        if (Object.values(summary).some((v) => v > 0)) {
          deps.runtime.logger.info("pve maintenance pass", fields);
        } else {
          deps.runtime.logger.debug("pve maintenance pass", fields);
        }
      } finally {
        clearInterval(slow);
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    } catch (error) {
      deps.runtime.logger.error("pve maintenance pass failed", {
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    } finally {
      client.release();
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  };
  timer = setTimeout(() => void tick(), 30_000);
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  deps.runtime.shutdownSignal.addEventListener("abort", stop, { once: true });
  return stop;
}
