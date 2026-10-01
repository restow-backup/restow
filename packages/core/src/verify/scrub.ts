/**
 * The scrub run for one tenant (docs/TESTING.md: pack integrity by SHA-256,
 * a sample weekly, everything monthly).
 *
 *   1. integrity: a random sample of packs (weekly) or every pack (monthly),
 *      plus every pack an earlier run left corrupt, checked on every target
 *      and repaired from an intact copy where possible (integrity.ts). A pack
 *      proven damaged on every target is marked damaged in the catalog: its
 *      chunks stop counting for deduplication, so later backups write intact
 *      copies of everything the source still holds (a full backup rewrites
 *      all of it) and the chunk rows move to those copies. A damaged pack no
 *      chunk row points to any more is retired: its row goes, its file waits
 *      out the superseded grace period like a swapped-out pack. A pack that
 *      checks intact again loses the mark.
 *   2. garbage collection: full runs re-pack packs with unreferenced chunks,
 *      leaving damaged packs untouched, and only when every checkpointed
 *      snapshot a retry may still resume could be read and no backup,
 *      restore or verify of the tenant is running (gc.ts). Checkpoints
 *      nothing can resume any more are deleted on the way
 *      (`gc.abandonedCheckpoint`)
 *   3. superseded packs: every run with collection enabled deletes the pack
 *      files earlier re-packs swapped out once their grace period is over,
 *      again only while no such job is running; the ones still waiting are
 *      listed in the report, and the next run picks them up from there
 *   4. orphan sweep: full runs delete pack files no row points to
 *
 * The result is a {@link ScrubReport}; the worker persists it with the job and
 * turns unrepaired corruption into red readiness reports for every object
 * whose snapshots use the damaged packs.
 */
import type { ProgressReporter } from "../engine/types.js";
import { buildCause } from "../failures/classify.js";
import type { CatalogPack } from "./catalog.js";
import { throwIfAborted } from "./errors.js";
import {
  type AbandonedCheckpointProbe,
  DEFAULT_SUPERSEDED_GRACE_MS,
  type GcBlocker,
  type GcSummary,
  type OrphanSweep,
  type ScrubEnvironment,
  type SupersededPack,
  type SupersededRelease,
  chunksHeldByPartialManifests,
  collectGarbage,
  releaseSupersededPacks,
  sweepOrphanPacks,
} from "./gc.js";
import {
  type PackCheck,
  type ScrubMode,
  checkPack,
  isProvenDamage,
  selectPacks,
} from "./integrity.js";
import { newSeed, seededRandom } from "./random.js";
import type { ReadinessReason } from "./readiness.js";
import { READINESS_REPORT_FORMAT } from "./report.js";

export type GcSkipReason = "sample_run" | "disabled" | "partial_manifest_unreadable" | GcBlocker;

export type ScrubGcResult =
  | ({ status: "completed" } & GcSummary)
  | { status: "skipped"; reason: GcSkipReason };

export type ScrubReport = {
  format: typeof READINESS_REPORT_FORMAT;
  mode: ScrubMode;
  seed: number | null;
  packsTotal: number;
  packsChecked: number;
  bytesChecked: number;
  ok: number;
  repaired: PackCheck[];
  /** Packs without any intact copy. Their paths are re-checked by every later run. */
  corrupt: PackCheck[];
  /**
   * Damaged packs whose every chunk later backups wrote again elsewhere: no
   * data depends on them any more, their rows were removed and their files
   * are released after the superseded grace period.
   */
  retired: string[];
  gc: ScrubGcResult;
  /**
   * Pack files swapped out by re-packs (this run's and earlier ones): how many
   * were deleted now, and which still wait out their grace period. The next
   * run continues from `pending`.
   */
  superseded: SupersededRelease;
  orphans: OrphanSweep | null;
  startedAt: string;
  durationMs: number;
};

export type ScrubOptions = {
  readonly mode: ScrubMode;
  readonly seed?: number;
  /** Paths the previous scrub left corrupt; always re-checked. */
  readonly previouslyCorrupt?: ReadonlySet<string>;
  /** Superseded packs the previous scrub left pending (its `superseded.pending`). */
  readonly previouslySuperseded?: readonly SupersededPack[];
  /**
   * Garbage collection (re-packing on full runs, releasing superseded packs on
   * every run); null disables it and deletes nothing.
   */
  readonly gc: {
    readonly cutoff: Date;
    readonly minDeadFraction?: number;
    /**
     * Reports a running backup, restore or verify of the tenant; collection
     * and the release of superseded packs yield to it.
     */
    readonly blockedBy?: () => Promise<GcBlocker | null>;
    /** How long swapped-out pack files are kept (default 24 h). */
    readonly supersededGraceMs?: number;
    /**
     * Tells checkpoints nothing can resume any more (row gone or committed, job
     * ended for good). Their partial manifests are deleted instead of keeping
     * their chunks or, when unreadable, blocking collection.
     */
    readonly abandonedCheckpoint?: AbandonedCheckpointProbe;
  } | null;
  readonly orphanGraceMs?: number;
  /** Rewrite failed targets from intact copies (default true). */
  readonly repair?: boolean;
  readonly packIdGenerator?: () => string;
};

async function runGc(
  env: ScrubEnvironment,
  options: ScrubOptions,
  damaged: readonly PackCheck[],
): Promise<ScrubGcResult> {
  if (options.mode !== "full") {
    return { status: "skipped", reason: "sample_run" };
  }
  if (!options.gc) {
    return { status: "skipped", reason: "disabled" };
  }
  const blocker = (await options.gc.blockedBy?.()) ?? null;
  if (blocker) {
    return { status: "skipped", reason: blocker };
  }
  const held = await chunksHeldByPartialManifests(env.storage, env.tenantId, env.keys, {
    abandoned: options.gc.abandonedCheckpoint,
    logger: env.logger,
  });
  if (held.unreadable.length > 0) {
    env.logger.warn("garbage collection skipped: a checkpointed snapshot is unreadable", {
      partials: held.unreadable,
    });
    return { status: "skipped", reason: "partial_manifest_unreadable" };
  }
  const summary = await collectGarbage(env, {
    cutoff: options.gc.cutoff,
    keep: held.ids,
    blockedBy: options.gc.blockedBy,
    exclude: new Set(damaged.map((pack) => pack.path)),
    minDeadFraction: options.gc.minDeadFraction,
    packIdGenerator: options.packIdGenerator,
    supersededGraceMs: options.gc.supersededGraceMs,
  });
  return { status: "completed", ...summary };
}

/**
 * Delete superseded pack files whose grace period is over; everything else
 * stays pending for the next run. Nothing is deleted while collection is
 * disabled or a job of the tenant reads or writes packs.
 */
async function settleSuperseded(
  env: ScrubEnvironment,
  options: ScrubOptions,
  gc: ScrubGcResult,
  retired: readonly SupersededPack[],
): Promise<SupersededRelease> {
  const pending = [
    ...(options.previouslySuperseded ?? []),
    ...retired,
    ...(gc.status === "completed" ? gc.superseded : []),
  ];
  const keepAll: SupersededRelease = { released: 0, releasedBytes: 0, pending };
  if (pending.length === 0 || !options.gc) {
    return keepAll;
  }
  const blocker = (await options.gc.blockedBy?.()) ?? null;
  if (blocker) {
    return keepAll;
  }
  return releaseSupersededPacks(
    env,
    pending,
    options.gc.supersededGraceMs ?? DEFAULT_SUPERSEDED_GRACE_MS,
  );
}

/**
 * Mark newly damaged packs and clear the mark of packs that are intact again.
 * When not a single checked pack was intact, nothing is marked: every pack
 * failing at once points at the storage target (an unmounted share, a wrong
 * path), not at damage to individual packs, and marking would make every
 * later backup upload its data again.
 */
async function recordDamage(
  env: ScrubEnvironment,
  damaged: readonly CatalogPack[],
  intact: readonly CatalogPack[],
  intactCount: number,
): Promise<void> {
  if (intact.length > 0) {
    await env.catalog.setDamaged(
      intact.map((pack) => pack.id),
      null,
    );
    env.logger.info("packs intact again, damage mark cleared", { packs: intact.length });
  }
  if (damaged.length === 0) {
    return;
  }
  if (intactCount === 0) {
    env.logger.warn("no checked pack is intact; packs are not marked damaged", {
      corrupt: damaged.length,
    });
    return;
  }
  await env.catalog.setDamaged(
    damaged.map((pack) => pack.id),
    env.now(),
  );
  env.logger.warn("packs marked damaged; later backups write their content again", {
    packs: damaged.map((pack) => pack.path),
  });
}

/** Check, repair and (on full runs) collect the tenant's pack store. */
export async function runScrub(
  env: ScrubEnvironment,
  progress: ProgressReporter,
  options: ScrubOptions,
): Promise<ScrubReport> {
  const startedAt = env.now();
  const seed = options.mode === "sample" ? (options.seed ?? newSeed()) : null;
  const packs: CatalogPack[] = await env.catalog.listPacks();
  const selected = selectPacks(
    packs,
    options.mode,
    seededRandom(seed ?? 0),
    options.previouslyCorrupt,
  );

  progress.phase("integrity");
  progress.total(selected.length);
  const repaired: PackCheck[] = [];
  const corrupt: PackCheck[] = [];
  const retired: SupersededPack[] = [];
  const nowDamaged: CatalogPack[] = [];
  const intactAgain: CatalogPack[] = [];
  let ok = 0;
  let bytesChecked = 0;
  for (const pack of selected) {
    throwIfAborted(env.signal);
    const chunks = await env.catalog.chunksOf(pack.id);
    const check = await checkPack(env.storage, env.tenantId, pack, chunks, {
      repair: options.repair,
    });
    bytesChecked += pack.size;
    if (check.status !== "corrupt") {
      if (pack.damagedAt) {
        intactAgain.push(pack);
      }
      if (check.status === "ok") {
        ok++;
      } else {
        repaired.push(check);
      }
      progress.advance(1, pack.size);
      continue;
    }
    if (pack.damagedAt && chunks.length === 0 && (await env.catalog.retireDamagedPack(pack))) {
      retired.push({ path: pack.path, size: pack.size, supersededAt: env.now().toISOString() });
      progress.advance(1, pack.size);
      continue;
    }
    corrupt.push(check);
    if (!pack.damagedAt && isProvenDamage(check)) {
      nowDamaged.push(pack);
    }
    const causes = check.targets
      .filter((target) => target.status !== "ok")
      .map((target) => `target ${target.target}: ${target.status}`);
    progress.fail(
      pack.path,
      `pack corrupt (${causes.join(", ")})`,
      buildCause("verify.storage_corrupt", { count: 1 }),
    );
  }
  throwIfAborted(env.signal);
  await recordDamage(env, nowDamaged, intactAgain, ok + repaired.length);

  progress.phase("garbage_collection");
  const gc = await runGc(env, options, corrupt);
  const superseded = await settleSuperseded(env, options, gc, retired);
  let orphans: OrphanSweep | null = null;
  if (gc.status === "completed") {
    progress.phase("orphans");
    orphans = await sweepOrphanPacks(
      env,
      options.orphanGraceMs,
      new Set(superseded.pending.map((pack) => pack.path)),
    );
  }

  const finishedAt = env.now();
  const report: ScrubReport = {
    format: READINESS_REPORT_FORMAT,
    mode: options.mode,
    seed,
    packsTotal: packs.length,
    packsChecked: ok + repaired.length + corrupt.length,
    bytesChecked,
    ok,
    repaired,
    corrupt,
    retired: retired.map((pack) => pack.path),
    gc,
    superseded,
    orphans,
    startedAt: startedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };
  env.logger.info("scrub finished", {
    mode: report.mode,
    checked: report.packsChecked,
    repaired: repaired.length,
    corrupt: corrupt.length,
    retired: retired.length,
    gc: gc.status,
    supersededReleased: superseded.released,
    supersededPending: superseded.pending.length,
  });
  return report;
}

/** `verify_reports.details` for an object whose data sits in packs a scrub found corrupt. */
export type ScrubFindingDetails = {
  format: typeof READINESS_REPORT_FORMAT;
  origin: "scrub";
  kind: "health_check";
  reasons: ReadinessReason[];
  scrubJobId: string;
  packs: Pick<PackCheck, "path" | "targets">[];
};

export function scrubFindingDetails(
  scrubJobId: string,
  packs: readonly PackCheck[],
): ScrubFindingDetails {
  return {
    format: READINESS_REPORT_FORMAT,
    origin: "scrub",
    kind: "health_check",
    reasons: [{ code: "storage_corrupt", severity: "red", count: packs.length }],
    scrubJobId,
    packs: packs.map((pack) => ({ path: pack.path, targets: pack.targets })),
  };
}
