import { createHash } from "node:crypto";
/**
 * Server-side work for Proxmox VE guests (docs/PVE.md, docs/PROXMOX.md 3):
 *
 *   plan       due PVE jobs become backup tasks for the node that hosts each guest
 *   stale      runs that never ended (48 hours) fail; their staged chunk references go;
 *              a backup run its node no longer lists in its heartbeat closes at once (#46)
 *   retention  restore points beyond the job's keep rules are pruned: their chunk
 *              references are released (garbage collection takes the chunks later),
 *              their manifest deleted, a container's restic snapshot forgotten
 *   verify     weekly, the newest restore point of every guest: a sample of its data
 *              blocks is read back from storage and compared with the SHA-256 in its
 *              map (containers: restic check of a 5 % subset)
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
 * One pass every five minutes, in one worker at a time (a session advisory lock).
 */
import {
  applyRetentionPolicy,
  type BlockMap,
  ChunkReader,
  DEFAULT_SCHEDULE_TIMEZONE,
  decodeBlockMap,
  deleteOnAllTargets,
  loadManifest,
  mapChunkIds,
  PVE_BOOT_TEST_CAPABILITY,
  protectionOnTargets,
  pveBootTestDue,
  pveBootTestPlan,
  pveBootTestTaskParams,
  pveDisksOf,
  pveGuestBackable,
  pveNextRunAt,
  pveNodeDeclares,
  resticBinary,
  resticCacheBase,
  resticCheck,
  resticForget,
  resticPrune,
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
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import {
  PgChunkIndex,
  PgSecretReader,
  tenantRunner,
  type WorkerRuntime,
  withTenantTx,
} from "../handlers/framework.js";
import { raiseEvents } from "../reporting.js";

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
/** Without a job's own rules: 7 daily, 4 weekly, 6 monthly. */
export const DEFAULT_PVE_RETENTION = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 };
const LOCK_KEY = 0x70766530; // "pve0"

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
    (g) => pveGuestBackable(g) && (g.jobId === job.id || (job.scopeAll && g.jobId === null)),
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
        status: run.snapshotId ? "succeeded" : "failed",
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
  let pruned = 0;
  for (const guest of guests) {
    const result = await withTenantTx(deps.db, guest.tenantId, async (tx) => {
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
    if (result.snaps.length <= 1) {
      continue;
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
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
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

async function forgetResticSnapshots(deps: PveDeps, guest: PveGuest, ids: string[]): Promise<void> {
  const access = await repositoryAccess(deps, guest);
  if (!access) {
    return;
  }
  await withGuestRepository(deps, guest.id, () =>
    withRepository(access, async (session) => {
      await resticForget(session, ids);
      await resticPrune(session);
    }),
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
        withRepository(access, (session) => resticCheck(session, "5%")),
      );
    } catch (error) {
      // Someone reads the repository (file restore): checked on a later pass, not failed.
      if (error instanceof EndpointRepositoryBusyError) {
        throw error;
      }
      result.errors.push(error instanceof Error ? error.message.slice(0, 500) : String(error));
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

export async function verifyDue(deps: PveDeps, now: Date): Promise<number> {
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
      ),
    )
    .limit(20);
  let n = 0;
  for (const guest of due) {
    const [snap] = await withTenantTx(deps.db, guest.tenantId, (tx) =>
      tx
        .select()
        .from(pveSnapshots)
        .where(and(eq(pveSnapshots.guestId, guest.id), eq(pveSnapshots.status, "active")))
        .orderBy(desc(pveSnapshots.sequence))
        .limit(1),
    );
    if (!snap) {
      continue;
    }
    let verify: Awaited<ReturnType<typeof verifySnapshot>>;
    try {
      verify = await verifySnapshot(deps, snap);
    } catch (error) {
      if (error instanceof EndpointRepositoryBusyError) {
        deps.runtime.logger.info("pve verify: the container repository is being read, later", {
          guestId: guest.id,
        });
        continue;
      }
      throw error;
    }
    await withTenantTx(deps.db, guest.tenantId, async (tx) => {
      await tx.update(pveSnapshots).set({ verify }).where(eq(pveSnapshots.id, snap.id));
      await tx.update(pveGuests).set({ lastVerifyAt: now }).where(eq(pveGuests.id, guest.id));
    });
    if (verify.errors.length > 0) {
      deps.runtime.logger.warn("pve verify found problems", {
        snapshotId: snap.id,
        errors: verify.errors.slice(0, 5),
      });
    }
    n++;
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
      const guest = guests[0];
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

export async function pvePass(deps: PveDeps): Promise<PvePassSummary> {
  const now = deps.runtime.now();
  const paused = deps.startsPaused?.() === true;
  return {
    tasks: paused ? 0 : await planJobs(deps, now),
    staleRuns: (await closeStaleRuns(deps, now)) + (await closeRunsNodesDropped(deps, now)),
    pruned: paused ? 0 : await applyRetention(deps, now),
    verified: paused ? 0 : await verifyDue(deps, now),
    restoreTests: paused ? 0 : await planRestoreTests(deps, now),
    bootTests: paused ? 0 : await planBootTests(deps, now),
    bootTestAlerts: await alertBootTests(deps, now),
    pveTokensDropped: await dropPveTokenSecrets(deps, now),
    downloadsPurged: await purgeDownloads(deps, now),
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
        return;
      }
      try {
        const summary = await pvePass(deps);
        if (Object.values(summary).some((v) => v > 0)) {
          deps.runtime.logger.info("pve maintenance pass", { ...summary });
        }
      } finally {
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
