/**
 * The scrub run for one tenant (docs/TESTING.md: pack integrity by SHA-256,
 * a sample weekly, everything monthly).
 *
 *   1. integrity: a random sample of packs (weekly) or every pack (monthly),
 *      plus (first) every pack an earlier run left corrupt or could not read,
 *      or only those (a recheck), checked on every target
 *      and repaired from an intact copy where possible (integrity.ts). A pack
 *      proven damaged on every target is marked damaged in the catalog: its
 *      chunks stop counting for deduplication, so later backups write intact
 *      copies of everything the source still holds (a full backup rewrites
 *      all of it) and the chunk rows move to those copies. A damaged pack no
 *      chunk row points to any more is retired: its row goes, its file waits
 *      out the superseded grace period like a swapped-out pack. A pack that
 *      checks intact again loses the mark. A pack that could not be read
 *      (transfer or permission errors after the retries of integrity.ts) is
 *      not damaged but "temporarily unreadable": the catalog counts the
 *      consecutive checks that failed to read it, and only a run of
 *      {@link UNREADABLE_CHECKS_LIMIT} over at least a day
 *      (isPersistentlyUnreadable) rates the objects using it like damage.
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
 * whose snapshots use the damaged packs (yellow ones for packs that are only
 * unreadable so far).
 */
import type { ProgressReporter, RecoveryReadiness } from "../engine/types.js";
import { buildCause } from "../failures/classify.js";
import type { CatalogPack, PackReadFailure, PackUnreadableState } from "./catalog.js";
import { throwIfAborted } from "./errors.js";
import {
  type AbandonedCheckpointProbe,
  chunksHeldByPartialManifests,
  collectGarbage,
  DEFAULT_SUPERSEDED_GRACE_MS,
  type GcBlocker,
  type GcSummary,
  type OrphanSweep,
  releaseSupersededPacks,
  type ScrubEnvironment,
  type SupersededPack,
  type SupersededRelease,
  sweepOrphanPacks,
} from "./gc.js";
import {
  checkPack,
  isPersistentlyUnreadable,
  isProvenDamage,
  type PackCheck,
  type PackReadRetry,
  type ScrubMode,
  selectPacks,
  UNREADABLE_CHECKS_LIMIT,
} from "./integrity.js";
import { newSeed, seededRandom } from "./random.js";
import { type ReadinessReason, worstReadiness } from "./readiness.js";
import { READINESS_REPORT_FORMAT } from "./report.js";

export type GcSkipReason = "sample_run" | "disabled" | "partial_manifest_unreadable" | GcBlocker;

/** The run of failed reads of an unreadable pack, as a report states it. */
export type UnreadableRun = {
  /** The first check of the run that could not read the pack. */
  since: string;
  /** This check. */
  lastAt: string;
  /** Consecutive checks that could not read it, this one included. */
  checks: number;
  /** Long enough to count like damage (isPersistentlyUnreadable). */
  persistent: boolean;
};

/** A pack no target could be read from (not proven damaged). */
export type UnreadablePackCheck = PackCheck & { unreadable: UnreadableRun };

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
  /**
   * Packs proven damaged: no intact copy, and every target answered with
   * damage (missing, wrong size or checksum, ...). Their paths are re-checked
   * by every later run.
   */
  corrupt: PackCheck[];
  /**
   * Packs without an intact copy that at least one target could not be read
   * from (a transfer or permission error even after reading again): not
   * proven damaged, re-checked first by every later run. Older reports listed
   * them under `corrupt`.
   */
  unreadable: UnreadablePackCheck[];
  /**
   * Packs an earlier check left damaged or unreadable that this run read
   * intact (or repaired): findings that named only such packs are over.
   */
  cleared: string[];
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
  /** Reading a pack again after transfer errors (integrity.ts defaults). */
  readonly retry?: PackReadRetry;
  readonly packIdGenerator?: () => string;
};

async function runGc(
  env: ScrubEnvironment,
  options: ScrubOptions,
  flagged: readonly PackCheck[],
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
    exclude: new Set(flagged.map((pack) => pack.path)),
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
  const keepAll: SupersededRelease = { released: 0, releasedBytes: 0, pending, deferredByLock: 0 };
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

/** The run of failed reads of `pack` including this check. */
function nextUnreadableRun(
  previous: PackUnreadableState | null | undefined,
  now: Date,
): UnreadableRun {
  const state = {
    since: previous?.since ?? now,
    lastAt: now,
    checks: (previous?.checks ?? 0) + 1,
  };
  return {
    since: state.since.toISOString(),
    lastAt: state.lastAt.toISOString(),
    checks: state.checks,
    persistent: isPersistentlyUnreadable(state),
  };
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
  const unreadable: UnreadablePackCheck[] = [];
  const readFailures: PackReadFailure[] = [];
  /** Packs that had a run of failed reads and were read now (intact or damaged). */
  const readAgain: string[] = [];
  const cleared: string[] = [];
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
      retry: options.retry,
      signal: env.signal,
    });
    bytesChecked += pack.size;
    const provenDamage = isProvenDamage(check);
    if (pack.unreadable && (check.status !== "corrupt" || provenDamage)) {
      readAgain.push(pack.id);
    }
    if (check.status !== "corrupt") {
      if (pack.damagedAt) {
        intactAgain.push(pack);
      }
      if (pack.damagedAt || pack.unreadable || options.previouslyCorrupt?.has(pack.path)) {
        cleared.push(pack.path);
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
    const causes = check.targets
      .filter((target) => target.status !== "ok")
      .map((target) => `target ${target.target}: ${target.status}`);
    if (!provenDamage) {
      const run = nextUnreadableRun(pack.unreadable, env.now());
      unreadable.push({ ...check, unreadable: run });
      readFailures.push({ packId: pack.id, detail: unreadableDetail(check) });
      progress.fail(
        pack.path,
        `pack unreadable in ${run.checks} consecutive ${run.checks === 1 ? "check" : "checks"} (${causes.join(", ")})`,
        buildCause(
          "verify.storage_unreadable",
          { count: 1 },
          { error: unreadableDetail(check) ?? "" },
        ),
      );
      continue;
    }
    corrupt.push(check);
    if (!pack.damagedAt) {
      nowDamaged.push(pack);
    }
    progress.fail(
      pack.path,
      `pack corrupt (${causes.join(", ")})`,
      buildCause("verify.storage_corrupt", { count: 1 }),
    );
  }
  throwIfAborted(env.signal);
  await recordDamage(env, nowDamaged, intactAgain, ok + repaired.length);
  await env.catalog.clearUnreadable(readAgain);
  await env.catalog.recordUnreadable(readFailures, env.now());
  if (unreadable.length > 0) {
    env.logger.warn("packs could not be read; they are checked again first next time", {
      packs: unreadable.map((pack) => pack.path),
      persistent: unreadable.filter((pack) => pack.unreadable.persistent).length,
      limit: UNREADABLE_CHECKS_LIMIT,
    });
  }

  progress.phase("garbage_collection");
  const gc = await runGc(env, options, [...corrupt, ...unreadable]);
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
    packsChecked: ok + repaired.length + corrupt.length + unreadable.length,
    bytesChecked,
    ok,
    repaired,
    corrupt,
    unreadable,
    cleared,
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
    unreadable: unreadable.length,
    retired: retired.length,
    gc: gc.status,
    supersededReleased: superseded.released,
    supersededPending: superseded.pending.length,
  });
  return report;
}

/** The errors of the targets that could not be read, for the catalog and the job's failure. */
function unreadableDetail(check: PackCheck): string | null {
  const details = check.targets
    .filter((target) => target.status === "unreadable")
    .map((target) => target.detail ?? target.status);
  return details.length > 0 ? details.join("; ").slice(0, 500) : null;
}

/**
 * `verify_reports.details` for an object whose data sits in packs a scrub
 * found corrupt or could not read. `cleared` marks the finding a scrub files
 * when every pack an earlier finding named was read intact again: it rates
 * nothing itself and ends the earlier finding (the object's own restore
 * checks rate it again).
 */
export type ScrubFindingDetails = {
  format: typeof READINESS_REPORT_FORMAT;
  origin: "scrub";
  kind: "health_check";
  reasons: ReadinessReason[];
  scrubJobId: string;
  packs: (Pick<PackCheck, "path" | "targets"> & { unreadable?: UnreadableRun })[];
  cleared?: true;
};

/** A finding for the packs an object uses: damaged ones, and ones no target could be read from. */
export function scrubFindingDetails(
  scrubJobId: string,
  damaged: readonly PackCheck[],
  unreadable: readonly UnreadablePackCheck[] = [],
): ScrubFindingDetails {
  const reasons: ReadinessReason[] = [];
  const persistent = unreadable.filter((pack) => pack.unreadable.persistent).length;
  if (damaged.length > 0) {
    reasons.push({ code: "storage_corrupt", severity: "red", count: damaged.length });
  }
  if (persistent > 0) {
    reasons.push({ code: "storage_unreadable_persistent", severity: "red", count: persistent });
  }
  if (unreadable.length - persistent > 0) {
    reasons.push({
      code: "storage_unreadable",
      severity: "yellow",
      count: unreadable.length - persistent,
    });
  }
  return {
    format: READINESS_REPORT_FORMAT,
    origin: "scrub",
    kind: "health_check",
    reasons,
    scrubJobId,
    packs: [
      ...damaged.map((pack) => ({ path: pack.path, targets: pack.targets })),
      ...unreadable.map((pack) => ({
        path: pack.path,
        targets: pack.targets,
        unreadable: pack.unreadable,
      })),
    ],
  };
}

/** The readiness a finding with these details rates the object (green: none, a cleared finding). */
export function scrubFindingReadiness(
  details: Pick<ScrubFindingDetails, "reasons">,
): RecoveryReadiness {
  return worstReadiness(details.reasons.map((reason) => reason.severity));
}

/** A finding that ends an earlier one: every pack it named was read intact again. */
export function scrubClearedFindingDetails(
  scrubJobId: string,
  paths: readonly string[],
): ScrubFindingDetails {
  return {
    format: READINESS_REPORT_FORMAT,
    origin: "scrub",
    kind: "health_check",
    reasons: [],
    scrubJobId,
    packs: paths.map((path) => ({ path, targets: [] })),
    cleared: true,
  };
}
