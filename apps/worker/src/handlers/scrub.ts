/**
 * The `scrub` queue handler: pack integrity and garbage collection for one
 * tenant (docs/TESTING.md: sample weekly, everything monthly; docs/
 * ARCHITECTURE.md: GC by re-packing, never in place).
 *
 * The run itself is core's `runScrub` (packages/core/src/verify/scrub.ts) over
 * {@link PgPackCatalog}. Around it this handler
 *   - re-checks every pack the previous scrub left corrupt, whatever the mode
 *   - lets garbage collection yield to running backups (a backup references
 *     its chunks only when it commits) and to running restores and verifies
 *     (they look chunk locations up as they go and must find every pack
 *     they were pointed at), and disables it outright while a storage
 *     migration (docs/STORAGE.md) is moving the tenant's packs to a new
 *     primary — nothing may re-pack or delete what it is copying or about to
 *     retire
 *   - discards in-progress snapshots whose job ended for good, and tells
 *     garbage collection which checkpoints nothing can resume any more, so
 *     their partial manifests are deleted instead of pinning chunks forever
 *     or, when unreadable, blocking collection for the tenant
 *   - hands the superseded pack files the previous scrub kept for their
 *     grace period to this run, which deletes the expired ones (the list lives
 *     in the report, `jobs.payload.result.superseded.pending`, so neither the
 *     schema nor the storage format changes). A scrub that fails after a swap
 *     loses its list with its report; those files are then ordinary orphans
 *     that a later full run's orphan sweep removes by file age, and only the
 *     yielding above protects readers of them.
 *   - files a red readiness report for every protected object whose active
 *     snapshots use a pack that is corrupt beyond repair, so the damage shows
 *     up per object immediately instead of at the next weekly verify
 *   - excludes packs a "keep" storage replacement left on its retired,
 *     read-only `previous` target from both the integrity check and the copy
 *     mirror (docs/STORAGE.md, {@link LegacyExcludingPackCatalog}): the
 *     current primary and copies never had them, so checking them there would
 *     report them "missing" everywhere and wrongly mark them damaged. A later
 *     "move" replacement copies them onto the current targets and closes
 *     this gap; until then they are not scrubbed
 *   - keeps `packs.damaged_at` for packs proven damaged (core `runScrub`
 *     marks, clears and retires them through {@link PgPackCatalog}); backups
 *     stop deduplicating against their chunks and write intact copies
 *   - raises an in-app notification for corruption and for repairs
 *   - refreshes `storage_targets.bytes_used` from the pack catalog
 *   - stores the report in `jobs.payload.result`
 *
 * Before the integrity pass it is also the tenant's copy job: every copy
 * target is brought up to the primary with core's `mirrorTenantStorage`
 * (keys, manifests, packs). New backups write to every target themselves;
 * the mirror fills in what existed before a copy target was added and heals
 * what a copy lost. Sample runs check objects on the copy by size, full runs
 * by SHA-256.
 */
import {
  type CatalogChunk,
  type CatalogPack,
  type GcBlocker,
  type JobQueue,
  type PackCatalog,
  type PackCheck,
  type PackReplacement,
  type ScrubJobPayload,
  type ScrubReport,
  type SupersededPack,
  type TenantMirrorReport,
  mirrorTenantStorage,
  runScrub,
  scrubFindingDetails,
} from "@restow/core";
import {
  type NewNotification,
  chunks,
  jobs,
  manifestObjects,
  packs,
  snapshots,
  storageMigrations,
  storageTargets,
  verifyReports,
} from "@restow/db";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { TenantTx, TenantTxRunner } from "../progress.js";
import { raiseEvents } from "../reporting.js";
import {
  type JobHandler,
  type JobOutcome,
  type WorkerJobContext,
  abandonedCheckpointProbe,
  discardAbandonedSnapshots,
  tenantRunner,
} from "./framework.js";
import { hasActiveMigration } from "./storage-migration.js";

const BATCH = 1000;

/** Unreferenced chunks stay this long before garbage collection may take them. */
export const GC_GRACE_HOURS = 72;

export function scrubModeOf(payload: Pick<ScrubJobPayload, "mode">): ScrubJobPayload["mode"] {
  return payload.mode === "full" ? "full" : "sample";
}

/** The collection cutoff: chunks unreferenced since before this may go. */
export function gcCutoff(now: Date, graceHours: number = GC_GRACE_HOURS): Date {
  return new Date(now.getTime() - graceHours * 3_600_000);
}

function batches<T>(items: readonly T[], size: number = BATCH): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pack catalog over `packs` / `chunks`
// ---------------------------------------------------------------------------

export class PgPackCatalog implements PackCatalog {
  constructor(
    private readonly run: TenantTxRunner,
    private readonly tenantId: string,
  ) {}

  private readonly packColumns = {
    id: packs.id,
    path: packs.path,
    sha256: packs.sha256,
    size: packs.size,
    createdAt: packs.createdAt,
    damagedAt: packs.damagedAt,
  };

  async setDamaged(packIds: readonly string[], at: Date | null): Promise<void> {
    if (packIds.length === 0) {
      return;
    }
    await this.run(async (tx) => {
      for (const batch of batches(packIds)) {
        await tx
          .update(packs)
          .set({ damagedAt: at === null ? null : sql`coalesce(${packs.damagedAt}, ${at})` })
          .where(and(eq(packs.tenantId, this.tenantId), inArray(packs.id, batch)));
      }
    });
  }

  async retireDamagedPack(pack: CatalogPack): Promise<boolean> {
    return this.run(async (tx) => {
      // Nothing adds rows to a damaged pack (recording moves rows away from
      // it, garbage collection leaves it alone); the lock keeps the check and
      // the delete together, and the foreign key refuses a pack still in use.
      const [locked] = await tx
        .select({ id: packs.id })
        .from(packs)
        .where(
          and(eq(packs.tenantId, this.tenantId), eq(packs.id, pack.id), isNotNull(packs.damagedAt)),
        )
        .for("update");
      if (!locked) {
        return false;
      }
      const [held] = await tx
        .select({ storedId: chunks.storedId })
        .from(chunks)
        .where(and(eq(chunks.tenantId, this.tenantId), eq(chunks.packId, pack.id)))
        .limit(1);
      if (held) {
        return false;
      }
      await tx.delete(packs).where(and(eq(packs.tenantId, this.tenantId), eq(packs.id, pack.id)));
      return true;
    });
  }

  async listPacks(): Promise<CatalogPack[]> {
    return this.run((tx) =>
      tx
        .select(this.packColumns)
        .from(packs)
        .where(eq(packs.tenantId, this.tenantId))
        .orderBy(asc(packs.createdAt), asc(packs.id)),
    );
  }

  async chunksOf(packId: string): Promise<CatalogChunk[]> {
    return this.run((tx) =>
      tx
        .select({
          storedId: chunks.storedId,
          offset: chunks.offsetBytes,
          length: chunks.length,
          refcount: chunks.refcount,
          updatedAt: chunks.updatedAt,
        })
        .from(chunks)
        .where(and(eq(chunks.tenantId, this.tenantId), eq(chunks.packId, packId)))
        .orderBy(asc(chunks.offsetBytes)),
    );
  }

  async collectablePacks(cutoff: Date): Promise<CatalogPack[]> {
    return this.run((tx) =>
      tx
        .selectDistinct(this.packColumns)
        .from(packs)
        .innerJoin(chunks, eq(chunks.packId, packs.id))
        .where(
          and(
            eq(packs.tenantId, this.tenantId),
            eq(chunks.refcount, 0),
            lt(chunks.updatedAt, cutoff),
          ),
        )
        .orderBy(asc(packs.createdAt), asc(packs.id)),
    );
  }

  async replacePack(change: PackReplacement): Promise<boolean> {
    const { oldPack, newPack, moved, dropped } = change;
    return this.run(async (tx) => {
      // Lock the old pack's rows: a concurrent snapshot commit that adds a
      // reference waits for this transaction, or has already bumped the
      // refcount and cancels the swap here.
      const rows = await tx
        .select({ storedId: chunks.storedId, refcount: chunks.refcount })
        .from(chunks)
        .where(and(eq(chunks.tenantId, this.tenantId), eq(chunks.packId, oldPack.id)))
        .for("update");
      const byId = new Map(rows.map((row) => [row.storedId, row.refcount]));
      const consistent =
        rows.length === moved.length + dropped.length &&
        moved.every((chunk) => byId.has(chunk.storedId)) &&
        dropped.every((id) => byId.get(id) === 0);
      if (!consistent) {
        return false;
      }
      if (newPack) {
        await tx.insert(packs).values({
          id: newPack.id,
          tenantId: this.tenantId,
          path: newPack.path,
          sha256: newPack.sha256,
          size: newPack.size,
        });
        for (const batch of batches(moved)) {
          const values = sql.join(
            batch.map(
              (chunk) =>
                sql`(${chunk.storedId}::text, ${chunk.offset}::bigint, ${chunk.length}::int)`,
            ),
            sql`, `,
          );
          // updated_at stays: it dates the last reference change, which a move is not.
          await tx.execute(sql`
            UPDATE ${chunks} AS c
            SET pack_id = ${newPack.id}::uuid, offset_bytes = v.offset_bytes, length = v.length
            FROM (VALUES ${values}) AS v(stored_id, offset_bytes, length)
            WHERE c.tenant_id = ${this.tenantId}::uuid
              AND c.pack_id = ${oldPack.id}::uuid
              AND c.stored_id = v.stored_id
          `);
        }
      }
      for (const batch of batches(dropped)) {
        await tx
          .delete(chunks)
          .where(
            and(
              eq(chunks.tenantId, this.tenantId),
              eq(chunks.packId, oldPack.id),
              inArray(chunks.storedId, batch),
            ),
          );
      }
      await tx
        .delete(packs)
        .where(and(eq(packs.tenantId, this.tenantId), eq(packs.id, oldPack.id)));
      return true;
    });
  }
}

/**
 * The switch time of the tenant's latest finished replacement, when it was a
 * "keep": that variant never copies anything (docs/STORAGE.md), so every pack
 * written before it lives only on the retired `previous` target, not on the
 * current primary or copies. Null when the latest replacement was a "move"
 * (which does copy everything, so nothing is missing from the current
 * targets any more, even if an earlier "keep" preceded it) or there was none.
 */
export async function loadKeepCutover(run: TenantTxRunner, tenantId: string): Promise<Date | null> {
  const [row] = await run((tx) =>
    tx
      .select({ mode: storageMigrations.mode, switchedAt: storageMigrations.switchedAt })
      .from(storageMigrations)
      .where(
        and(
          eq(storageMigrations.tenantId, tenantId),
          eq(storageMigrations.status, "completed"),
          isNotNull(storageMigrations.switchedAt),
        ),
      )
      .orderBy(desc(storageMigrations.switchedAt))
      .limit(1),
  );
  return row?.mode === "keep" ? (row.switchedAt as Date) : null;
}

/**
 * A {@link PackCatalog} that hides packs a "keep" replacement left behind on
 * the retired `previous` target (see {@link loadKeepCutover}): `listPacks`
 * and `collectablePacks` (what the integrity pass checks and what the copy
 * mirror brings copies up to date with) return only packs written at or after
 * the cutover, the ones the current primary and copies are actually expected
 * to hold. Checking a legacy pack against the current targets would find it
 * "missing" everywhere and mark it damaged, which is wrong: it is exactly
 * where "keep" always meant to leave it. `previous` is read-only, so scrubbing
 * it is not this catalog's job; the gap is a known limitation (docs/
 * STORAGE.md) until those packs are moved by a later "move" replacement,
 * which copies them onto the current targets and closes it.
 */
export class LegacyExcludingPackCatalog implements PackCatalog {
  constructor(
    private readonly inner: PackCatalog,
    private readonly cutover: Date,
  ) {}

  async listPacks(): Promise<CatalogPack[]> {
    const packs = await this.inner.listPacks();
    return packs.filter((pack) => pack.createdAt >= this.cutover);
  }

  async collectablePacks(cutoff: Date): Promise<CatalogPack[]> {
    const packs = await this.inner.collectablePacks(cutoff);
    return packs.filter((pack) => pack.createdAt >= this.cutover);
  }

  chunksOf(packId: string): Promise<CatalogChunk[]> {
    return this.inner.chunksOf(packId);
  }

  replacePack(change: PackReplacement): Promise<boolean> {
    return this.inner.replacePack(change);
  }

  setDamaged(packIds: readonly string[], at: Date | null): Promise<void> {
    return this.inner.setDamaged(packIds, at);
  }

  retireDamagedPack(pack: CatalogPack): Promise<boolean> {
    return this.inner.retireDamagedPack(pack);
  }
}

// ---------------------------------------------------------------------------
// Reading earlier results
// ---------------------------------------------------------------------------

/** Pack paths a stored scrub report lists as corrupt; tolerant of older or partial shapes. */
export function corruptPackPathsOf(result: unknown): string[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const corrupt = (result as { corrupt?: unknown }).corrupt;
  if (!Array.isArray(corrupt)) {
    return [];
  }
  return corrupt
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as { path?: unknown }).path : null,
    )
    .filter((path): path is string => typeof path === "string" && path.length > 0);
}

/**
 * Superseded pack files a stored scrub report left pending; tolerant of older
 * reports (which have none) and of malformed entries, which are dropped. A
 * dropped entry is not lost: its file is an ordinary orphan to the sweep.
 */
export function supersededPacksOf(result: unknown): SupersededPack[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const superseded = (result as { superseded?: unknown }).superseded;
  const pending =
    superseded && typeof superseded === "object"
      ? (superseded as { pending?: unknown }).pending
      : undefined;
  if (!Array.isArray(pending)) {
    return [];
  }
  const packs: SupersededPack[] = [];
  for (const entry of pending) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const { path, size, supersededAt } = entry as Record<string, unknown>;
    if (
      typeof path === "string" &&
      path.length > 0 &&
      typeof size === "number" &&
      Number.isFinite(size) &&
      size >= 0 &&
      typeof supersededAt === "string" &&
      !Number.isNaN(Date.parse(supersededAt))
    ) {
      packs.push({ path, size, supersededAt });
    }
  }
  return packs;
}

/** What the next scrub carries over from the latest completed one. */
export interface PreviousScrub {
  /** Packs it left corrupt; every scrub re-checks them. */
  readonly corrupt: Set<string>;
  /** Swapped-out pack files still inside their grace period. */
  readonly superseded: SupersededPack[];
}

/**
 * The latest completed scrub's carry-over. Every scrub re-checks the corrupt
 * packs and passes on the superseded ones it did not delete, so the latest
 * report is authoritative for both.
 */
export async function loadPreviousScrub(
  run: TenantTxRunner,
  tenantId: string,
): Promise<PreviousScrub> {
  const [row] = await run((tx) =>
    tx
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.queue, "scrub"),
          eq(jobs.status, "completed"),
          isNotNull(jobs.completedAt),
        ),
      )
      .orderBy(desc(jobs.completedAt))
      .limit(1),
  );
  const result = row?.payload?.result;
  return {
    corrupt: new Set(corruptPackPathsOf(result)),
    superseded: supersededPacksOf(result),
  };
}

/**
 * Packs known to be corrupt: the ones the latest completed scrub reported
 * (see {@link loadPreviousScrub}) and the ones marked damaged in the catalog.
 * The mark outlives a report that only sampled other packs.
 */
export async function loadCorruptPackPaths(
  run: TenantTxRunner,
  tenantId: string,
): Promise<Set<string>> {
  const [previous, marked] = await Promise.all([
    loadPreviousScrub(run, tenantId),
    run((tx) =>
      tx
        .select({ path: packs.path })
        .from(packs)
        .where(and(eq(packs.tenantId, tenantId), isNotNull(packs.damagedAt))),
    ),
  ]);
  return new Set([...previous.corrupt, ...marked.map((row) => row.path)]);
}

/**
 * The queues whose running jobs garbage collection yields to, with the reason
 * it reports. Backups (and archive syncs) write packs and reference their
 * chunks only when they commit; restores and verifies read packs through
 * locations they look up as they go.
 */
const GC_BLOCKING_QUEUES = {
  backup: "backup_running",
  archive: "backup_running",
  restore: "restore_running",
  verify: "verify_running",
} as const satisfies Partial<Record<JobQueue, GcBlocker>>;

type GcBlockingQueue = keyof typeof GC_BLOCKING_QUEUES;

const GC_BLOCKER_ORDER: readonly GcBlocker[] = [
  "backup_running",
  "restore_running",
  "verify_running",
];

/** The blocker to report for the queues that have a running job; backups first. */
export function gcBlockerOf(activeQueues: readonly string[]): GcBlocker | null {
  const found = new Set<GcBlocker>();
  for (const queue of activeQueues) {
    if (Object.hasOwn(GC_BLOCKING_QUEUES, queue)) {
      found.add(GC_BLOCKING_QUEUES[queue as GcBlockingQueue]);
    }
  }
  return GC_BLOCKER_ORDER.find((blocker) => found.has(blocker)) ?? null;
}

/**
 * Whether a job of the tenant is running that garbage collection must yield
 * to, including a storage migration that started after this scrub run began
 * (`hasActiveMigration`, `storage-migration.ts`): the handler below only skips
 * garbage collection outright when a migration is already active *before* the
 * run starts, but `blockedBy` (core `runScrub`) asks this again before
 * collection, between every two packs, and again before superseded pack files
 * are released, so a migration that starts mid-run is caught here instead.
 * Reported as `backup_running`: core's {@link GcBlocker} has no dedicated
 * value for a migration yet (adding one is a change to
 * `packages/core/src/verify/gc.ts`'s `GcBlocker` union and its readiness
 * text), and a migration is, like a backup, a process actively moving the
 * tenant's packs elsewhere, so the same yield applies for the same reason:
 * nothing may be re-packed or deleted out from under it.
 */
export async function gcBlockerFor(
  run: TenantTxRunner,
  tenantId: string,
): Promise<GcBlocker | null> {
  const rows = await run((tx) =>
    tx
      .selectDistinct({ queue: jobs.queue })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          inArray(jobs.queue, Object.keys(GC_BLOCKING_QUEUES) as GcBlockingQueue[]),
          eq(jobs.status, "active"),
        ),
      ),
  );
  const blocker = gcBlockerOf(rows.map((row) => row.queue));
  if (blocker) {
    return blocker;
  }
  return (await hasActiveMigration(run, tenantId)) ? "backup_running" : null;
}

// ---------------------------------------------------------------------------
// Consequences of a run
// ---------------------------------------------------------------------------

/**
 * Protected objects whose active snapshots reference chunks of the given
 * packs. Runs only for packs that are corrupt beyond repair, which is rare,
 * so a scan of the manifest mirror is acceptable here.
 */
async function objectsUsingPacks(
  tx: TenantTx,
  tenantId: string,
  damaged: readonly PackCheck[],
): Promise<Map<string, PackCheck[]>> {
  const affected = new Map<string, PackCheck[]>();
  for (const pack of damaged) {
    const rows = await tx
      .select({ storedId: chunks.storedId })
      .from(chunks)
      .where(and(eq(chunks.tenantId, tenantId), eq(chunks.packId, pack.packId)));
    const objectIds = new Set<string>();
    for (const batch of batches(rows.map((row) => row.storedId))) {
      const ids = sql.join(
        batch.map((id) => sql`${id}`),
        sql`, `,
      );
      const referencing = await tx
        .selectDistinct({ protectedObjectId: manifestObjects.protectedObjectId })
        .from(manifestObjects)
        .innerJoin(snapshots, eq(snapshots.id, manifestObjects.snapshotId))
        .where(
          and(
            eq(manifestObjects.tenantId, tenantId),
            eq(snapshots.status, "active"),
            sql`${manifestObjects.chunkRefs} ?| ARRAY[${ids}]::text[]`,
          ),
        );
      for (const row of referencing) {
        objectIds.add(row.protectedObjectId);
      }
    }
    for (const objectId of objectIds) {
      affected.set(objectId, [...(affected.get(objectId) ?? []), pack]);
    }
  }
  return affected;
}

/** In-app notification events this handler raises (the UI translates them). */
export const SCRUB_EVENTS = {
  corrupt: "scrub.corrupt",
  repaired: "scrub.repaired",
} as const;

export function scrubNotifications(
  tenantId: string,
  jobId: string,
  report: Pick<ScrubReport, "corrupt" | "repaired" | "mode">,
  affectedObjects: number,
): NewNotification[] {
  const result: NewNotification[] = [];
  if (report.corrupt.length > 0) {
    result.push({
      tenantId,
      level: "error",
      event: SCRUB_EVENTS.corrupt,
      message: `${report.corrupt.length} pack files are damaged on every storage target and could not be repaired; ${affectedObjects} protected objects are affected. A full backup of those objects writes the damaged content again from the source, as far as the source still holds it.`,
      details: {
        jobId,
        mode: report.mode,
        corrupt: report.corrupt.length,
        affectedObjects,
        packs: report.corrupt.slice(0, 20).map((pack) => pack.path),
      },
    });
  }
  if (report.repaired.length > 0) {
    result.push({
      tenantId,
      level: "warning",
      event: SCRUB_EVENTS.repaired,
      message: `${report.repaired.length} damaged pack files were repaired from an intact copy.`,
      details: {
        jobId,
        mode: report.mode,
        repaired: report.repaired.length,
        packs: report.repaired.slice(0, 20).map((pack) => pack.path),
      },
    });
  }
  return result;
}

async function persistReport(
  run: TenantTxRunner,
  ctx: WorkerJobContext,
  report: ScrubReport,
  copies: CopyMirrorSummary | null,
): Promise<number> {
  return run(async (tx) => {
    const affected =
      report.corrupt.length > 0
        ? await objectsUsingPacks(tx, ctx.tenantId, report.corrupt)
        : new Map<string, PackCheck[]>();
    const checkedAt = ctx.now();
    for (const batch of batches([...affected.entries()])) {
      await tx.insert(verifyReports).values(
        batch.map(([protectedObjectId, damaged]) => ({
          tenantId: ctx.tenantId,
          protectedObjectId,
          jobId: ctx.jobId,
          kind: "health_check" as const,
          recoveryReadiness: "red" as const,
          details: scrubFindingDetails(ctx.jobId, damaged),
          checkedAt,
        })),
      );
    }
    const raised = scrubNotifications(ctx.tenantId, ctx.jobId, report, affected.size);
    await raiseEvents(tx, raised);
    await tx.execute(sql`
      UPDATE ${storageTargets}
      SET bytes_used = (SELECT coalesce(sum(p.size), 0) FROM ${packs} AS p WHERE p.tenant_id = ${ctx.tenantId}::uuid),
          updated_at = now()
      WHERE tenant_id = ${ctx.tenantId}::uuid
    `);
    await tx
      .update(jobs)
      .set({
        payload: sql`coalesce(${jobs.payload}, '{}'::jsonb) || ${JSON.stringify({ result: { ...report, copies } })}::jsonb`,
      })
      .where(and(eq(jobs.tenantId, ctx.tenantId), eq(jobs.id, ctx.jobId)));
    return affected.size;
  });
}

// ---------------------------------------------------------------------------
// Copy targets
// ---------------------------------------------------------------------------

/** What the job records about the copy mirror (the full per-object report is logged). */
export interface CopyMirrorSummary {
  readonly copies: number;
  readonly complete: boolean;
  readonly copied: number;
  readonly repaired: number;
  readonly failed: number;
  readonly bytesWritten: number;
}

export function copyMirrorSummary(report: TenantMirrorReport): CopyMirrorSummary {
  const sum = (field: "copied" | "repaired" | "failed" | "bytesWritten") =>
    report.copies.reduce((total, copy) => total + copy[field], 0);
  return {
    copies: report.copies.length,
    complete: report.complete,
    copied: sum("copied"),
    repaired: sum("repaired"),
    failed: sum("failed"),
    bytesWritten: sum("bytesWritten"),
  };
}

/** Bring every copy target up to the primary; null when the tenant has no copy. */
export async function mirrorCopies(
  ctx: Pick<WorkerJobContext, "tenantId" | "storage" | "signal" | "logger" | "now">,
  catalog: Pick<PackCatalog, "listPacks">,
  mode: ScrubJobPayload["mode"],
): Promise<CopyMirrorSummary | null> {
  const storage = ctx.storage;
  if (storage.copies.length === 0) {
    return null;
  }
  const logger = ctx.logger.child({ component: "copy-mirror" });
  const report = await mirrorTenantStorage({
    tenantId: ctx.tenantId,
    storage,
    packs: await catalog.listPacks(),
    verify: mode === "full" ? "hash" : "size",
    signal: ctx.signal,
    logger,
    now: ctx.now,
  });
  const summary = copyMirrorSummary(report);
  if (!summary.complete) {
    logger.warn("copy targets incomplete after mirror", {
      failed: summary.failed,
      problems: report.copies.flatMap((copy) =>
        copy.problems.slice(0, 5).map((problem) => problem.key),
      ),
    });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const scrubHandler: JobHandler<"scrub"> = {
  queue: "scrub",

  async run(ctx: WorkerJobContext, payload: ScrubJobPayload): Promise<JobOutcome> {
    const mode = scrubModeOf(payload);
    const run = tenantRunner(ctx.db, ctx.tenantId);
    const rawCatalog = new PgPackCatalog(run, ctx.tenantId);
    // A "keep" replacement never copies anything onto the current targets
    // (docs/STORAGE.md), so packs from before it live only on the retired,
    // read-only `previous` target: hide them from the integrity check and
    // the copy mirror below rather than let either report them "missing" on
    // every current target (see LegacyExcludingPackCatalog).
    const keepCutover = await loadKeepCutover(run, ctx.tenantId);
    const catalog = keepCutover
      ? new LegacyExcludingPackCatalog(rawCatalog, keepCutover)
      : rawCatalog;
    // Snapshots whose job ended for good but whose own cleanup did not run
    // (a crash between the last attempt and its bookkeeping, or a job
    // cancelled while it waited for a retry): nothing resumes them.
    const abandonedSnapshots = await discardAbandonedSnapshots(
      run,
      { tenantId: ctx.tenantId, storage: ctx.storage, logger: ctx.logger },
      { tenant: true },
    );
    const copies = await mirrorCopies(ctx, catalog, mode);
    const previous = await loadPreviousScrub(run, ctx.tenantId);
    // A storage migration reads the primary's packs to copy them elsewhere
    // and, once verified, retires it to `previous`; garbage collection must
    // not delete or re-pack anything while that is happening, so it is
    // disabled for this run entirely rather than merely yielded to it (GC
    // yields mid-run to backup/restore/verify, but a migration takes longer
    // than those and its own status already tells the operator why nothing
    // was collected this time). Corruption checking and the copy mirror above
    // are unaffected: they do not touch what the migration is moving.
    const migrationActive = await hasActiveMigration(run, ctx.tenantId);
    const report = await runScrub(
      {
        tenantId: ctx.tenantId,
        storage: ctx.storage,
        keys: ctx.keys,
        catalog,
        logger: ctx.logger.child({ component: "scrub", mode }),
        signal: ctx.signal,
        now: ctx.now,
      },
      ctx.progress,
      {
        mode,
        previouslyCorrupt: previous.corrupt,
        previouslySuperseded: previous.superseded,
        gc: migrationActive
          ? null
          : {
              cutoff: gcCutoff(ctx.now()),
              blockedBy: () => gcBlockerFor(run, ctx.tenantId),
              abandonedCheckpoint: abandonedCheckpointProbe(run, ctx.tenantId),
            },
      },
    );
    const affectedObjects = await persistReport(run, ctx, report, copies);
    return {
      summary: {
        mode,
        ...(migrationActive ? { migrationActive: true } : {}),
        ...(copies ? { copies } : {}),
        packsTotal: report.packsTotal,
        packsChecked: report.packsChecked,
        repaired: report.repaired.length,
        corrupt: report.corrupt.length,
        retired: report.retired.length,
        affectedObjects,
        abandonedSnapshots,
        gc: report.gc.status === "completed" ? "completed" : report.gc.reason,
        supersededReleased: report.superseded.released,
        supersededPending: report.superseded.pending.length,
      },
    };
  },
};
