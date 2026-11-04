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
 *              unproven boot test raises boot_test.failed / boot_test.unproven once
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
  isDeleteRefused,
  isObjectLocked,
  listLockFiles,
  loadManifest,
  locksToRemove,
  mapChunkIds,
  measureRepositoryBytes,
  PVE_BOOT_TEST_CAPABILITY,
  protectionOnTargets,
  pveBootTestDue,
  pveBootTestPlan,
  pveBootTestTaskParams,
  pveDisksOf,
  pveGuestCounted,
  pveNextRunAt,
  pveNodeDeclares,
  pveSelfBackupBlocked,
  ResticError,
  removeLockFiles,
  resticBinary,
  resticCacheBase,
  resticCheck,
  resticErrorDetail,
  resticForget,
  resticPrune,
  resticUnlock,
  type StorageTargets,
  sampleDataBlocks,
  type TenantKeyring,
  withRepository,
} from "@restow/core";
import {
  type Database,
  EndpointRepositoryBusyError,
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
import {
  PgChunkIndex,
  PgSecretReader,
  tenantRunner,
  type WorkerRuntime,
  withTenantTx,
} from "../handlers/framework.js";
import { hasActiveMigration } from "../handlers/storage-migration.js";
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
const STALE_RUN_MS = 48 * 60 * 60 * 1000;
const VERIFY_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const RESTORE_TEST_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
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

export async function closeStaleRuns(deps: PveDeps, now: Date): Promise<number> {
  const stale = await deps.providerDb
    .select({ id: pveRuns.id, tenantId: pveRuns.tenantId, snapshotId: pveRuns.snapshotId })
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
    .select({ id: pveRuns.id, tenantId: pveRuns.tenantId, snapshotId: pveRuns.snapshotId })
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
    .select({ id: pveRuns.id, tenantId: pveRuns.tenantId, snapshotId: pveRuns.snapshotId })
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

/** A run is not called orphaned before this: its task's result may be on its way. */
const ORPHANED_RUN_GRACE_MS = 10 * 60 * 1000;

export const PVE_ORPHANED_RUN_MESSAGE =
  "The node never reported the end of this run; its task is over or its access to the repository has expired, so the server ended it.";

/**
 * Restore, restore check and boot test runs that nothing will close any more, so they do not
 * keep their guest busy (`guestBusy`: no restore check) until the 48 hours are over:
 *
 *   - its task is over (done, failed, cancelled) and the run is still open;
 *   - a restore without a task (a container restore the node asked a credential for, e.g. the
 *     restore of a boot test on a node before 0.5.0, or one started in the PVE UI) whose
 *     credential expired or was never issued: it cannot read anything any more;
 *   - such a restore that started during a boot test of the same guest and restore point that
 *     has ended: it was that boot test's restore;
 *   - a restore check or boot test run whose task is gone.
 *
 * Each ends failed with {@link PVE_ORPHANED_RUN_MESSAGE}. Runs left open by an earlier version
 * heal on the first pass after the update.
 */
export async function closeOrphanedRuns(deps: PveDeps, now: Date): Promise<number> {
  const settled = new Date(now.getTime() - ORPHANED_RUN_GRACE_MS);
  const orphaned = await deps.providerDb
    .select({ id: pveRuns.id, tenantId: pveRuns.tenantId })
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
              lt(pveRuns.resticExpiresAt, now),
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
    const [updated] = await withTenantTx(deps.db, run.tenantId, (tx) =>
      tx
        .update(pveRuns)
        .set({ status: "failed", finishedAt: now, errorMessage: PVE_ORPHANED_RUN_MESSAGE })
        .where(and(eq(pveRuns.id, run.id), eq(pveRuns.status, "running")))
        .returning({ id: pveRuns.id }),
    );
    if (updated) {
      closed++;
    }
  }
  return closed;
}

/**
 * Close a run that is still `running`: succeeded when its restore point was committed,
 * else failed with `message`; what it staged is released. False when it ended meanwhile.
 */
async function closeRun(
  deps: PveDeps,
  run: { id: string; tenantId: string; snapshotId: string | null },
  now: Date,
  message: string,
): Promise<boolean> {
  const staged = await withTenantTx(deps.db, run.tenantId, async (tx) => {
    const [updated] = await tx
      .update(pveRuns)
      .set({
        // A run stopped in the UI ends cancelled, not failed.
        status: run.snapshotId
          ? "succeeded"
          : sql<
              "failed" | "cancelled"
            >`CASE WHEN ${pveRuns.cancelRequestedAt} IS NOT NULL THEN 'cancelled' ELSE 'failed' END`,
        finishedAt: now,
        errorMessage: run.snapshotId ? null : message,
      })
      .where(and(eq(pveRuns.id, run.id), eq(pveRuns.status, "running")))
      .returning({ id: pveRuns.id });
    if (!updated) {
      return null;
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
  await deleteOnAllTargets(ctx.storage, snap.manifestPath, deps.runtime.logger);
}

export async function applyRetention(deps: PveDeps, now: Date): Promise<number> {
  const guests = await deps.providerDb.select().from(pveGuests);
  const mode = guests.length > 0 ? await retentionHoldMode(deps.providerDb) : null;
  let pruned = 0;
  // A "move" storage migration copies the containers' repositories file by file: retention
  // waits for it, so no restic file it listed is pruned away under it (per tenant, once a run).
  const migrating = new Map<string, boolean>();
  for (const guest of guests) {
    try {
      pruned += await retainGuest(deps, guest, now, mode, migrating);
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

/** Retention of one guest (see `applyRetention`); how many restore points it pruned. */
async function retainGuest(
  deps: PveDeps,
  guest: PveGuest,
  now: Date,
  mode: Awaited<ReturnType<typeof retentionHoldMode>> | null,
  migrating: Map<string, boolean>,
): Promise<number> {
  let pruned = 0;
  let busy = migrating.get(guest.tenantId);
  if (busy === undefined) {
    busy = await hasActiveMigration(tenantRunner(deps.db, guest.tenantId), guest.tenantId);
    migrating.set(guest.tenantId, busy);
  }
  if (busy) {
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
      // Held on suspicion: no restore point goes, so no chunk reference is released either.
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
  if (result === null || result.snaps.length <= 1) {
    return 0;
  }
  const decision = applyRetentionPolicy(
    result.snaps.map((s) => ({ id: s.id, time: s.backupAt })),
    result.rules,
    result.zone,
  );
  const forget: string[] = [];
  for (const id of decision.remove) {
    const snap = result.snaps.find((s) => s.id === id) as PveSnapshot;
    try {
      // A restore point the storage still locks stays until a later run (docs/STORAGE.md).
      if (await pveSnapshotLocked(deps, guest, snap)) {
        continue;
      }
      await pruneSnapshot(deps, snap, now);
      pruned++;
      if (snap.resticSnapshotId) {
        forget.push(snap.resticSnapshotId);
      }
    } catch (error) {
      deps.runtime.logger.warn("pve retention: could not prune a restore point", {
        snapshotId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (forget.length > 0) {
    await forgetResticSnapshots(deps, guest, forget).catch((error) =>
      deps.runtime.logger.warn("pve retention: restic forget failed", {
        guestId: guest.id,
        error: resticErrorDetail(error, 500),
      }),
    );
  }
  return pruned;
}

/** Whether a target still locks the restore point's manifest or restic snapshot file. */
async function pveSnapshotLocked(deps: PveDeps, guest: PveGuest, snap: PveSnapshot) {
  const storage = await deps.runtime.storage.get(guest.tenantId);
  const targets = [storage.primary, ...storage.copies];
  const keys = [
    ...(snap.manifestPath ? [snap.manifestPath] : []),
    ...(snap.resticSnapshotId ? [`pve-guests/${guest.id}/snapshots/${snap.resticSnapshotId}`] : []),
  ];
  for (const key of keys) {
    if (await protectionOnTargets(targets, key)) {
      return true;
    }
  }
  return false;
}

async function repositoryAccess(deps: PveDeps, guest: PveGuest) {
  const password = await guestRepositoryPassword(deps, guest);
  if (!password) {
    return null;
  }
  const storage = await deps.runtime.storage.get(guest.tenantId);
  return {
    storage: storage.primary,
    prefix: `pve-guests/${guest.id}/`,
    repositoryPassword: password,
    repositoryKey: guest.id,
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
  };
}

/**
 * Clear the stale locks of a container repository before the server's restic works on it.
 *
 * A lock file the storage received more than 30 minutes ago is removed straight from the
 * storage: restic writes a fresh lock file (with a new name) every five minutes while it works,
 * so a live run never has an older one. `restic unlock` alone judges by the time inside the
 * file and did not lift a backup's lock left behind for weeks (CT 113, every check postponed
 * as "repository locked"); with `resticUnlock` it still runs after (bounded by
 * {@link PVE_UNLOCK_TIMEOUT_MS}), and what it says is logged, not swallowed.
 *
 * A storage that refuses the deletion (a write-once share: EPERM, or Object Lock) can never
 * lose a lock file: that is logged once as such, `restic unlock` is not run (it could only fail
 * the same way), and the result says so (`deletesRefused`), so the caller leaves out what needs
 * the exclusive lock.
 */
async function clearStaleGuestLocks(
  deps: PveDeps,
  access: Pick<NonNullable<Awaited<ReturnType<typeof repositoryAccess>>>, "storage" | "prefix">,
  session: Parameters<typeof resticUnlock>[0] | null,
  guestId: string,
): Promise<{ deletesRefused: boolean }> {
  let stale: string[] = [];
  try {
    const present = await listLockFiles(access.storage, access.prefix);
    stale = locksToRemove(present, {
      agentLocks: new Set(),
      agentActive: false,
      now: deps.runtime.now(),
    });
  } catch (error) {
    deps.runtime.logger.warn("pve: the locks of a container repository could not be listed", {
      guestId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  if (stale.length > 0) {
    try {
      await removeLockFiles(access.storage, access.prefix, stale);
      deps.runtime.logger.info("pve: stale locks of a container repository removed", {
        guestId,
        locks: stale.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isDeleteRefused(error) || isObjectLocked(error)) {
        deps.runtime.logger.warn(
          "pve: stale locks of a container repository cannot be removed: the storage refuses deletes (write-once storage)",
          { guestId, locks: stale.length, errorMessage },
        );
        return { deletesRefused: true };
      }
      deps.runtime.logger.warn("pve: stale locks of a container repository could not be removed", {
        guestId,
        locks: stale.length,
        errorMessage,
      });
    }
  }
  if (session) {
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

/** restic forget and prune of a container repository (retention; exported for tests). */
export async function forgetResticSnapshots(
  deps: PveDeps,
  guest: PveGuest,
  ids: string[],
): Promise<void> {
  const access = await repositoryAccess(deps, guest);
  if (!access) {
    return;
  }
  const done = await withGuestRepository(deps, guest.id, () =>
    withRepository(access, async (session) => {
      // Stale locks only (a run that ended without releasing its lock), as for machines.
      const { deletesRefused } = await clearStaleGuestLocks(deps, access, session, guest.id);
      if (deletesRefused) {
        // Forget and prune take the exclusive lock and delete: on a storage that refuses
        // deletes they can only fail (and each try would leave one more lock file behind).
        deps.runtime.logger.warn(
          "pve retention: the storage of a container repository refuses deletes, restic forget and prune are left out",
          { guestId: guest.id, snapshots: ids.length },
        );
        return false;
      }
      const limits = { signal: deps.runtime.shutdownSignal };
      await resticForget(session, ids, { ...limits, timeoutMs: PVE_FORGET_TIMEOUT_MS });
      await resticPrune(session, { ...limits, timeoutMs: PVE_PRUNE_TIMEOUT_MS });
      return true;
    }),
  );
  if (!done) {
    return;
  }
  // The prune freed space the restic route never saw: measure the repository again.
  const repositoryBytes = await measureRepositoryBytes(access.storage, access.prefix);
  await withTenantTx(deps.db, guest.tenantId, (tx) =>
    tx
      .update(pveGuests)
      .set({ repositoryBytes, repositoryMeasuredAt: deps.runtime.now() })
      .where(eq(pveGuests.id, guest.id)),
  );
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
    try {
      await withGuestRepository(deps, snap.guestId, () =>
        withRepository(access, async (session) => {
          // Stale lock files go from the storage (a run that ended without releasing its lock),
          // so the node's next backup does not meet them; restic unlock is not needed here.
          await clearStaleGuestLocks(deps, access, null, snap.guestId);
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
 * a boot test: its restic holds or will take the repository's lock), or its node took on a
 * backup of it that has not started its run yet. Indexed (pve_runs_guest_started_idx,
 * pve_tasks_open_backup_idx), one probe per candidate row.
 */
function guestBusy(guestId: SQL, now: Date): SQL {
  const runsSince = new Date(now.getTime() - BUSY_RUN_MS);
  return sql`(EXISTS (SELECT 1 FROM ${pveRuns} r
      WHERE r.guest_id = ${guestId} AND r.started_at > ${runsSince} AND r.status = 'running')
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

/** Whether the guest is busy now (`guestBusy`), asked right before its check starts. */
async function guestIsBusy(deps: PveDeps, guestId: string, now: Date): Promise<boolean> {
  const { rows } = await deps.providerDb.execute<{ busy: boolean }>(
    sql`SELECT ${guestBusy(sql`${guestId}::uuid`, now)} AS busy`,
  );
  return rows[0]?.busy === true;
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

export async function planRestoreTests(deps: PveDeps, now: Date): Promise<number> {
  const jobs = await deps.providerDb.select().from(pveJobs).where(eq(pveJobs.enabled, true));
  let n = 0;
  for (const job of jobs) {
    const test = job.settings.restoreTest;
    if (!test?.enabled || !test.targetStorage) {
      continue;
    }
    n += await withTenantTx(deps.db, job.tenantId, async (tx) => {
      const guests = coveredBy(job, await tx.select().from(pveGuests)).filter(
        (g) =>
          g.lastSnapshotId !== null &&
          !(g.kind === "ct" && g.privileged) &&
          (g.lastRestoreTestAt === null ||
            g.lastRestoreTestAt.getTime() < now.getTime() - RESTORE_TEST_EVERY_MS),
      );
      // A guest whose restore check is due is checked first (`checkComesFirst`).
      const checkFirst = new Set(
        guests.length === 0
          ? []
          : (
              await tx
                .select({ id: pveGuests.id })
                .from(pveGuests)
                .where(
                  and(
                    inArray(
                      pveGuests.id,
                      guests.map((g) => g.id),
                    ),
                    checkComesFirst(sql`${pveGuests.id}`, now),
                  ),
                )
            ).map((row) => row.id),
      );
      const guest = guests.find((g) => !checkFirst.has(g.id));
      if (!guest) {
        return 0;
      }
      const [snap] = await tx
        .select()
        .from(pveSnapshots)
        .where(eq(pveSnapshots.id, guest.lastSnapshotId as string));
      const [node] = await tx
        .select()
        .from(pveNodes)
        .where(
          and(
            eq(pveNodes.clusterId, guest.clusterId),
            eq(pveNodes.name, guest.node ?? ""),
            isNull(pveNodes.revokedAt),
          ),
        );
      if (snap?.status !== "active" || !node) {
        return 0;
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
      await tx.update(pveGuests).set({ lastRestoreTestAt: now }).where(eq(pveGuests.id, guest.id));
      return 1;
    });
  }
  return n;
}

// ---------------------------------------------------------------------------
// Boot tests (docs/PVE.md, "Boot test")
// ---------------------------------------------------------------------------

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
        (g) => g.lastSnapshotId !== null && !(g.kind === "ct" && g.privileged),
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
        if (!snap) {
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
        const [tried] = await tx
          .select({ id: pveRuns.id })
          .from(pveRuns)
          .where(
            and(
              eq(pveRuns.guestId, guest.id),
              eq(pveRuns.kind, "boot_test"),
              eq(pveRuns.snapshotId, snap.id),
            ),
          )
          .limit(1);
        const due = pveBootTestDue(
          {
            schedule: plan.schedule,
            lastBootTestAt: guest.lastBootTestAt,
            newest: {
              backupAt: snap.backupAt,
              tested: snap.bootTest !== null || tried !== undefined,
            },
          },
          now,
        );
        if (!due) {
          continue;
        }
        const [task] = await tx
          .insert(pveTasks)
          .values({
            tenantId: job.tenantId,
            nodeId: node.id,
            guestId: guest.id,
            kind: "boot_test",
            params: { ...pveBootTestTaskParams(snap, guest.vmid, plan), jobId: job.id },
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
  const bootTestAlerts = await step("boot test alerts", () => alertBootTests(deps, now));
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
