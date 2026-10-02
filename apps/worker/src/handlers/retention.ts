/**
 * The `retention` queue handler: expire backup snapshots by policy.
 *
 * A retention run is tenant-wide (the scheduler enqueues one per tenant). It
 * evaluates every protected object's restore point history against the
 * tenant's snapshot retention policy (the tiered keep rule and its guards
 * live in @restow/core, packages/core/src/retention) and prunes what the
 * policy no longer requires:
 *
 *   1. the snapshot row flips to `pruned` (invisible to restore and verify),
 *   2. the chunk references its manifest held are released,
 *   3. the mirrored manifest_objects rows and the manifest file are removed.
 *
 * Chunks themselves are never deleted here; unreferenced chunks are garbage
 * collected by the scrub job (docs/ARCHITECTURE.md, Chunk-Store). The order
 * above is crash-safe in the conservative direction: an interrupted run can
 * leave references counted too high (storage kept), never too low.
 *
 * Policies live in `retention_policies` (docs/ARCHIVE.md); a row whose
 * `applies_to.target` is "snapshots" governs backups. Without one, every
 * snapshot is kept. `planRetentionRun` (the same function the retention API's
 * preview uses) is what decides what is due; this handler only supplies it
 * with the tenant's data and carries out what it returns.
 *
 * Other retention work (the archive deletion run of docs/ARCHIVE.md) plugs in
 * through {@link retentionTasks}, so the archive module can register its task
 * without touching this handler.
 */
import {
  type JobRetentionAssignment,
  type LegalHoldScope,
  type Logger,
  type RetentionJobPayload,
  type RetentionPolicyRow,
  type SnapshotCandidate,
  classifyFailure,
  jobRetentionAssignments,
  loadManifest,
  parseSnapshotPolicy,
  planRetentionRun,
  withJobRetention,
} from "@restow/core";
import {
  backupJobMembers,
  backupJobs,
  legalHolds,
  manifestObjects,
  protectedObjects,
  reportableError,
  retentionPolicies,
  safeErrorMessage,
  snapshots,
  sources,
  verifyReports,
} from "@restow/db";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { TenantTxRunner } from "../progress.js";
import {
  type JobHandler,
  type JobOutcome,
  type WorkerJobContext,
  tenantRunner,
} from "./framework.js";

const RELEASE_BATCH = 1000;

// ---------------------------------------------------------------------------
// Persistence seam
// ---------------------------------------------------------------------------

/** Everything the snapshot task reads or writes outside the engine seams; Postgres by default. */
export interface RetentionStore {
  loadPolicies(): Promise<RetentionPolicyRow[]>;
  /**
   * The retention policies mail jobs name, with the objects of each job: those objects follow
   * the named policy unless a policy is scoped to the object itself. Omitted by stores that
   * know no jobs.
   */
  loadJobRetention?(): Promise<JobRetentionAssignment[]>;
  loadLegalHolds(): Promise<LegalHoldScope>;
  /** Completed, active restore points of the tenant. */
  loadCompletedSnapshots(): Promise<SnapshotCandidate[]>;
  /**
   * The manifest path loaded for a snapshot by {@link loadCompletedSnapshots};
   * throws for an id it never returned (retention only ever prunes a
   * candidate that store handed it).
   */
  manifestPathOf(snapshotId: string): string;
  /** Flip the row to pruned; false when another run got there first. */
  markPruned(snapshotId: string): Promise<boolean>;
  /** Chunk ids from the mirrored index, for when the manifest is unreadable. */
  loadMirroredChunkIds(snapshotId: string): Promise<string[] | null>;
  /** Remove the mirrored rows; returns how many. */
  deleteManifestObjects(snapshotId: string): Promise<number>;
}

/**
 * Every query names the tenant explicitly, on top of Row Level Security, so a
 * connection that bypasses RLS (a superuser in a development setup) can never
 * apply one tenant's policy to another tenant's snapshots.
 */
export function pgRetentionStore(run: TenantTxRunner, tenantId: string): RetentionStore {
  const manifestPaths = new Map<string, string>();
  return {
    async loadPolicies() {
      return run((tx) =>
        tx
          .select({
            id: retentionPolicies.id,
            name: retentionPolicies.name,
            isDefault: retentionPolicies.isDefault,
            appliesTo: retentionPolicies.appliesTo,
            // A row saved before presets existed falls back to this plain
            // column (@restow/core parseSnapshotPolicy); the retention API's
            // preview reads the whole row the same way, so this must never
            // drop out of the projection (see the parity test).
            years: retentionPolicies.years,
          })
          .from(retentionPolicies)
          .where(eq(retentionPolicies.tenantId, tenantId))
          .orderBy(asc(retentionPolicies.createdAt)),
      );
    },

    async loadJobRetention() {
      return run(async (tx) => {
        const named = await tx
          .select({
            id: backupJobs.id,
            scopeMode: backupJobs.scopeMode,
            retentionPolicyId: backupJobs.retentionPolicyId,
          })
          .from(backupJobs)
          .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.kind, "mail")));
        if (!named.some((job) => job.retentionPolicyId !== null)) {
          return [];
        }
        const members = await tx
          .select({
            jobId: backupJobMembers.jobId,
            protectedObjectId: backupJobMembers.protectedObjectId,
          })
          .from(backupJobMembers)
          .where(eq(backupJobMembers.tenantId, tenantId));
        const objects = await tx
          .select({ id: protectedObjects.id, sourceKind: sources.kind })
          .from(protectedObjects)
          .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
          .where(eq(protectedObjects.tenantId, tenantId));
        return jobRetentionAssignments(
          named,
          members.flatMap((member) =>
            member.protectedObjectId
              ? [{ jobId: member.jobId, protectedObjectId: member.protectedObjectId }]
              : [],
          ),
          objects.map((object) => ({ id: object.id, imported: object.sourceKind === "import" })),
        );
      });
    },

    async loadLegalHolds() {
      const rows = await run((tx) =>
        tx
          .select({ protectedObjectId: legalHolds.protectedObjectId })
          .from(legalHolds)
          .where(and(eq(legalHolds.tenantId, tenantId), eq(legalHolds.active, true))),
      );
      const ids = new Set<string>();
      let tenantWide = false;
      for (const row of rows) {
        if (row.protectedObjectId === null) {
          tenantWide = true;
        } else {
          ids.add(row.protectedObjectId);
        }
      }
      return { tenantWide, protectedObjectIds: ids };
    },

    async loadCompletedSnapshots() {
      const rows = await run((tx) =>
        tx
          .select({
            id: snapshots.id,
            protectedObjectId: snapshots.protectedObjectId,
            sequence: snapshots.sequence,
            manifestPath: snapshots.manifestPath,
            byteSize: snapshots.byteSize,
            completedAt: snapshots.completedAt,
          })
          .from(snapshots)
          .where(
            and(
              eq(snapshots.tenantId, tenantId),
              eq(snapshots.status, "active"),
              isNotNull(snapshots.manifestPath),
            ),
          )
          .orderBy(asc(snapshots.protectedObjectId), asc(snapshots.sequence)),
      );
      if (rows.length === 0) {
        return [];
      }
      const ids = rows.map((row) => row.id);
      const verifiedRows = await run((tx) =>
        tx
          .selectDistinct({ snapshotId: verifyReports.snapshotId })
          .from(verifyReports)
          .where(
            and(
              eq(verifyReports.tenantId, tenantId),
              inArray(verifyReports.snapshotId, ids),
              eq(verifyReports.recoveryReadiness, "green"),
            ),
          ),
      );
      const verified = new Set(
        verifiedRows.flatMap((row) => (row.snapshotId ? [row.snapshotId] : [])),
      );
      return rows.flatMap((row) => {
        if (row.manifestPath === null) {
          return [];
        }
        manifestPaths.set(row.id, row.manifestPath);
        return [
          {
            id: row.id,
            protectedObjectId: row.protectedObjectId,
            sequence: row.sequence,
            byteSize: row.byteSize,
            completedAt: row.completedAt,
            verified: verified.has(row.id),
          },
        ];
      });
    },

    manifestPathOf(snapshotId) {
      const path = manifestPaths.get(snapshotId);
      if (!path) {
        throw new Error(`no manifest path loaded for snapshot ${snapshotId}`);
      }
      return path;
    },

    async markPruned(snapshotId) {
      const rows = await run((tx) =>
        tx
          .update(snapshots)
          .set({ status: "pruned" })
          .where(
            and(
              eq(snapshots.tenantId, tenantId),
              eq(snapshots.id, snapshotId),
              eq(snapshots.status, "active"),
            ),
          )
          .returning({ id: snapshots.id }),
      );
      return rows.length === 1;
    },

    async loadMirroredChunkIds(snapshotId) {
      const rows = await run((tx) =>
        tx
          .select({ chunkRefs: manifestObjects.chunkRefs })
          .from(manifestObjects)
          .where(
            and(eq(manifestObjects.tenantId, tenantId), eq(manifestObjects.snapshotId, snapshotId)),
          ),
      );
      return rows.length === 0 ? null : rows.flatMap((row) => row.chunkRefs ?? []);
    },

    async deleteManifestObjects(snapshotId) {
      const rows = await run((tx) =>
        tx
          .delete(manifestObjects)
          .where(
            and(eq(manifestObjects.tenantId, tenantId), eq(manifestObjects.snapshotId, snapshotId)),
          )
          .returning({ id: manifestObjects.id }),
      );
      return rows.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/** Chunk ids a snapshot references: from its manifest, else from the mirrored index. */
async function referencedChunkIds(
  ctx: WorkerJobContext,
  store: RetentionStore,
  snapshot: SnapshotCandidate,
  manifestPath: string,
  logger: Logger,
): Promise<string[] | null> {
  try {
    const manifest = await loadManifest(ctx.storage, manifestPath, ctx.keys);
    return manifest.objects.flatMap((object) => object.chunks);
  } catch (error) {
    logger.warn("manifest unreadable, releasing references from the mirrored index", {
      snapshotId: snapshot.id,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  return store.loadMirroredChunkIds(snapshot.id);
}

export interface PruneOutcome {
  readonly chunkReferencesReleased: number;
  readonly manifestObjectsDeleted: number;
}

/** Prune one snapshot (see the module comment for the order and why). */
export async function pruneSnapshot(
  ctx: WorkerJobContext,
  store: RetentionStore,
  snapshot: SnapshotCandidate,
  logger: Logger,
): Promise<PruneOutcome | null> {
  if (!(await store.markPruned(snapshot.id))) {
    return null;
  }
  const manifestPath = store.manifestPathOf(snapshot.id);
  const ids = await referencedChunkIds(ctx, store, snapshot, manifestPath, logger);
  if (ids === null) {
    logger.warn("no chunk references found for pruned snapshot; scrub will reconcile", {
      snapshotId: snapshot.id,
    });
  } else {
    for (let i = 0; i < ids.length; i += RELEASE_BATCH) {
      await ctx.chunkIndex.releaseReferences(ids.slice(i, i + RELEASE_BATCH));
    }
  }
  const manifestObjectsDeleted = await store.deleteManifestObjects(snapshot.id);
  for (const target of [ctx.storage.primary, ...ctx.storage.copies]) {
    await target.delete(manifestPath);
  }
  logger.info("snapshot pruned", {
    snapshotId: snapshot.id,
    sequence: snapshot.sequence,
    chunkReferences: ids?.length ?? 0,
    bytes: snapshot.byteSize,
  });
  return { chunkReferencesReleased: ids?.length ?? 0, manifestObjectsDeleted };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface RetentionTaskOptions {
  readonly dryRun: boolean;
}

/** A unit of retention work; the archive module registers its deletion run here. */
export interface RetentionTask {
  readonly name: string;
  run(ctx: WorkerJobContext, options: RetentionTaskOptions): Promise<Record<string, unknown>>;
}

export class RetentionTaskRegistry {
  private readonly tasks = new Map<string, RetentionTask>();

  constructor(tasks: Iterable<RetentionTask> = []) {
    for (const task of tasks) {
      this.register(task);
    }
  }

  register(task: RetentionTask): this {
    if (this.tasks.has(task.name)) {
      throw new Error(`retention task ${task.name} is already registered`);
    }
    this.tasks.set(task.name, task);
    return this;
  }

  list(): RetentionTask[] {
    return [...this.tasks.values()];
  }
}

export interface SnapshotRetentionSummary {
  readonly policies: number;
  readonly objects: number;
  readonly candidates: number;
  readonly pruned: number;
  readonly held: number;
  readonly bytesLogical: number;
  readonly chunkReferencesReleased: number;
  readonly dryRun: boolean;
}

/** Snapshot expiry, the task this handler ships with. */
export function createSnapshotRetentionTask(
  storeFor: (ctx: WorkerJobContext) => RetentionStore = (ctx) =>
    pgRetentionStore(tenantRunner(ctx.db, ctx.tenantId), ctx.tenantId),
): RetentionTask {
  return {
    name: "snapshots",

    async run(ctx, options): Promise<Record<string, unknown>> {
      const store = storeFor(ctx);
      const logger = ctx.logger.child({ task: "snapshots" });
      const rows = await store.loadPolicies();
      const tenantPolicies = rows
        .map((row) => parseSnapshotPolicy(row))
        .filter((policy) => policy !== null);
      // The objects of a job that names a policy follow it (an object's own policy still wins).
      const policies = withJobRetention(tenantPolicies, (await store.loadJobRetention?.()) ?? []);
      const summary = {
        policies: tenantPolicies.length,
        objects: 0,
        candidates: 0,
        pruned: 0,
        held: 0,
        bytesLogical: 0,
        chunkReferencesReleased: 0,
        dryRun: options.dryRun,
      } satisfies SnapshotRetentionSummary;
      if (tenantPolicies.length === 0) {
        logger.info("no snapshot retention policy; keeping every snapshot");
        return { ...summary };
      }

      const holds = await store.loadLegalHolds();
      const history = await store.loadCompletedSnapshots();
      const plan = planRetentionRun(history, policies, holds, ctx.now());
      summary.objects = plan.objectsEvaluated;
      summary.candidates = plan.expired.length;
      summary.held = plan.held.length;
      if (plan.held.length > 0) {
        logger.info("legal hold suspends snapshot retention for held restore points", {
          restorePoints: plan.held.length,
        });
      }

      ctx.progress.total(plan.expired.length);
      ctx.progress.phase(options.dryRun ? "evaluate" : "prune");

      for (const snapshot of plan.expired) {
        if (ctx.signal.aborted) {
          break;
        }
        if (options.dryRun) {
          summary.bytesLogical += snapshot.byteSize;
          ctx.progress.advance(1, snapshot.byteSize);
          continue;
        }
        try {
          const outcome = await pruneSnapshot(ctx, store, snapshot, logger);
          if (outcome) {
            summary.pruned++;
            summary.bytesLogical += snapshot.byteSize;
            summary.chunkReferencesReleased += outcome.chunkReferencesReleased;
          }
          ctx.progress.advance(1, snapshot.byteSize);
        } catch (error) {
          ctx.progress.fail(
            snapshot.id,
            `prune failed: ${safeErrorMessage(error)}`,
            classifyFailure(reportableError(error)),
          );
        }
      }
      return { ...summary };
    },
  };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/** Registered retention tasks; the archive module adds its deletion run at startup. */
export const retentionTasks = new RetentionTaskRegistry([createSnapshotRetentionTask()]);

export function createRetentionHandler(registry: RetentionTaskRegistry): JobHandler<"retention"> {
  return {
    queue: "retention",
    // Housekeeping runs one at a time per process; it competes with nobody for Graph quota.
    concurrency: 1,

    async run(ctx: WorkerJobContext, payload: RetentionJobPayload): Promise<JobOutcome> {
      const dryRun = payload.dryRun === true;
      const summary: Record<string, unknown> = { dryRun };
      for (const task of registry.list()) {
        if (ctx.signal.aborted) {
          break;
        }
        summary[task.name] = await task.run(ctx, { dryRun });
      }
      return { summary };
    },
  };
}

export const retentionHandler = createRetentionHandler(retentionTasks);
