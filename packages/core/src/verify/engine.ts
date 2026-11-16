/**
 * The verify run for one protected object: the weekly restore proof of
 * docs/TESTING.md (restore proof in production).
 *
 *   1. load the latest committed snapshot and its manifest
 *   2. draw a random sample (20 mails, 20 files, a few calendar and contact
 *      items), or take every object for a health check
 *   3. read each object back through the restore path and compare it with
 *      the manifest (check.ts)
 *   4. optionally restore the verified sample into a test target (probe.ts)
 *   5. rate the outcome green / yellow / red with reasons (readiness.ts)
 *
 * Findings are never swallowed: every item that did not come back byte-exact
 * is reported to the job's progress as a failure and listed in the report.
 *
 * Red needs evidence (evidence.ts): data that is missing, does not match or
 * does not decode. A read that fails for any other reason (the storage does
 * not answer, times out, returns a 5xx or throttles; an unknown error) proves
 * nothing: the read-back stops there, and unless the items read so far or the
 * storage check already prove damage, the run ends with
 * {@link VerifyIncompleteError}: no rating, no report, retried by the worker.
 * A test restore that failed only for such reasons counts the same way. Only
 * cancellation aborts the run otherwise.
 *
 * A manifest no target has is evidence only when every target still holds the
 * tenant's other data (presence.ts): then it was deleted, and the backup cannot
 * be restored (`manifest_missing`, red). An emptied or unmounted target answers
 * "not found" for everything and leaves the check incomplete. Checks that stay
 * incomplete one after the other are not left to an old green: the worker
 * records {@link unverifiedOutcome} after {@link INCOMPLETE_CHECKS_LIMIT}.
 *
 * Which packs a snapshot uses is resolved through the chunk index (the same
 * lookup the restore path does), never from `SnapshotManifest.packs`: that
 * list records where the chunks were written at backup time, and garbage
 * collection moves surviving chunks into new packs. After a re-pack it is
 * informational only.
 */
import { ChunkReader } from "../engine/chunkstore.js";
import { contentOf } from "../engine/content.js";
import { loadManifest } from "../engine/snapshot.js";
import type {
  ChunkIndex,
  JobContext,
  ProtectedObjectRef,
  SnapshotRecord,
  VerifyOptions,
  VerifyResult,
} from "../engine/types.js";
import { buildCause, classifyFailure } from "../failures/classify.js";
import type { FailureCause } from "../failures/types.js";
import type { SnapshotManifest } from "../manifest.js";
import {
  checkObjectWithParts,
  type InconclusiveRead,
  type ItemCheck,
  type ItemCheckStatus,
} from "./check.js";
import { describeError, isAbortError, throwIfAborted, VerifyIncompleteError } from "./errors.js";
import { isTestRestoreEvidence, readEvidence } from "./evidence.js";
import { targetsHoldTenant } from "./presence.js";
import type { RestoreProbe, TestRestoreOutcome } from "./probe.js";
import { newSeed, seededRandom } from "./random.js";
import {
  assessReadiness,
  type BackupFailureFacts,
  DEFAULT_READINESS_POLICY,
  type ReadinessPolicy,
} from "./readiness.js";
import {
  listedItems,
  READINESS_REPORT_FORMAT,
  type ReportSnapshotRef,
  type VerifyCounts,
  type VerifyReportDetails,
} from "./report.js";
import {
  emptyCounts,
  PROBE_CATEGORIES,
  planFull,
  planSample,
  quotaFor,
  type SamplePlan,
  type SampleQuota,
} from "./sampling.js";
import { sourceEvidence } from "./source.js";

export type VerifyRunOptions = VerifyOptions & {
  /** Seed for the sample draw; a fresh random seed when omitted. */
  readonly seed?: number;
  readonly policy?: ReadinessPolicy;
  /** Restore the sample into a test target as well. */
  readonly probe?: RestoreProbe | null;
  /** Storage keys of packs the latest scrub reported corrupt and could not repair. */
  readonly damagedPacks?: ReadonlySet<string>;
  /**
   * Storage keys of packs the storage check could not read lately: a reason
   * for attention, or (the `persistent` ones) like damage.
   */
  readonly unreadablePacks?: ReadonlySet<string>;
  readonly persistentlyUnreadablePacks?: ReadonlySet<string>;
  /**
   * The items the run that made `snapshot` could not back up (readiness `backup_incomplete`):
   * the worker reads them from the run's job (`jobs.item_failure_summary`).
   */
  readonly backupFailures?: (snapshot: SnapshotRecord) => Promise<BackupFailureFacts | null>;
};

export type VerifyOutcome = VerifyResult & {
  readonly snapshotId: string | null;
  readonly details: VerifyReportDetails;
};

const EMPTY_PLAN: SamplePlan = { items: [], eligible: emptyCounts() };

/** Stored ids per chunk-index lookup (keeps each query well below parameter limits). */
const LOCATE_BATCH = 1000;

/**
 * The packs among `damaged` that currently hold a chunk of `manifest`,
 * resolved through the chunk index (see the module comment for why not
 * `manifest.packs`). Stops looking once every damaged pack was found. Chunks
 * the index does not know are the read-back's business, not this one's.
 */
export async function damagedPacksOfSnapshot(
  index: ChunkIndex,
  manifest: Pick<SnapshotManifest, "objects">,
  damaged: ReadonlySet<string> | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!damaged || damaged.size === 0) {
    return [];
  }
  const ids = [...new Set(manifest.objects.flatMap((object) => object.chunks))];
  const found = new Set<string>();
  for (let i = 0; i < ids.length && found.size < damaged.size; i += LOCATE_BATCH) {
    if (signal) {
      throwIfAborted(signal);
    }
    const located = await index.locate(ids.slice(i, i + LOCATE_BATCH));
    for (const location of located.values()) {
      if (damaged.has(location.packPath)) {
        found.add(location.packPath);
      }
    }
  }
  return [...found].sort();
}

export { contentOf };

function snapshotRef(record: SnapshotRecord, manifest: SnapshotManifest | null): ReportSnapshotRef {
  const content = manifest ? contentOf(manifest) : null;
  const signal = manifest?.sourceSignal;
  const evidence = sourceEvidence(signal);
  return {
    id: record.id,
    sequence: record.sequence,
    completedAt: record.completedAt?.toISOString() ?? null,
    itemCount: manifest?.objects.length ?? record.itemCount,
    packCount: manifest?.packs?.length ?? 0,
    ...(content ? { contentBytes: content.bytes, contentObjects: content.objects } : {}),
    ...(signal && evidence ? { source: { ...evidence, signal } } : {}),
  };
}

function tally(plan: SamplePlan, checks: readonly ItemCheck[]): VerifyCounts {
  const sampled = emptyCounts();
  for (const item of plan.items) {
    sampled[item.category]++;
  }
  const outcomes: Record<ItemCheckStatus, number> = {
    verified: 0,
    mismatch: 0,
    missing: 0,
    unreadable: 0,
  };
  let bytesRead = 0;
  for (const check of checks) {
    outcomes[check.status]++;
    bytesRead += check.bytesRead;
  }
  return { eligible: plan.eligible, sampled, checked: checks.length, bytesRead, ...outcomes };
}

async function readManifest(
  ctx: JobContext,
  record: SnapshotRecord,
): Promise<{
  manifest: SnapshotManifest | null;
  missing: boolean;
  error: string | null;
  cause: FailureCause | null;
}> {
  const key = record.manifestPath as string;
  try {
    return {
      manifest: await loadManifest(ctx.storage, key, ctx.keys),
      missing: false,
      error: null,
      cause: null,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const cause = classifyFailure(error, { role: "storage" });
    // A manifest that does not decode is evidence. One the storage did not return proves
    // nothing by itself, not even a definite "not found": the manifest is the first object a
    // check reads, and an emptied or unmounted target answers exactly so. Only when every
    // target still holds the tenant's other data is "not found" the manifest's own loss.
    const evidence = readEvidence(error);
    if (
      evidence === "missing" &&
      (await targetsHoldTenant(ctx.storage, ctx.tenantId, new Set([key])))
    ) {
      return {
        manifest: null,
        missing: true,
        error: describeError(error),
        cause: buildCause("verify.manifest_missing", {}, cause.technical),
      };
    }
    if (evidence === null || evidence === "missing") {
      throw new VerifyIncompleteError(
        `the manifest of the latest backup could not be read (${describeError(error)})`,
        cause,
        { cause: error },
      );
    }
    // The classifier names the damage (a key that does not open it); "manifest unreadable" is the fallback.
    return {
      manifest: null,
      missing: false,
      error: describeError(error),
      cause:
        cause.code === "unknown" || cause.code === "storage.error"
          ? buildCause("verify.manifest_unreadable", {}, cause.technical)
          : cause,
    };
  }
}

async function runProbe(
  ctx: JobContext,
  probe: RestoreProbe,
  protectedObject: ProtectedObjectRef,
  snapshotId: string,
  plan: SamplePlan,
  checks: readonly ItemCheck[],
): Promise<TestRestoreOutcome | null> {
  // Only items whose bytes are intact go to the target; the others already failed. Site
  // metadata, list schemas and list items are read back only: a target cannot take them.
  const intact = new Set(checks.filter((check) => check.status === "verified").map((c) => c.path));
  const sample = plan.items
    .filter((item) => PROBE_CATEGORIES.has(item.category))
    .map((item) => item.object)
    .filter((object) => intact.has(object.path));
  if (sample.length === 0) {
    return null;
  }
  ctx.progress.phase("test_restore");
  try {
    return await probe.run(ctx, protectedObject, snapshotId, sample);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const reason = describeError(error);
    const cause = classifyFailure(error);
    return {
      target: probe.target,
      items: sample.map((object) => ({
        path: object.path,
        status: "failed" as const,
        reason,
        cause,
      })),
    };
  }
}

/** Verify one protected object against its latest snapshot. */
export async function verifyProtectedObject(
  ctx: JobContext,
  protectedObject: ProtectedObjectRef,
  options: VerifyRunOptions,
): Promise<VerifyOutcome> {
  const startedAt = ctx.now();
  const logger = ctx.logger.child({
    component: "verify",
    protectedObjectId: protectedObject.id,
    kind: options.kind,
  });
  const scope = options.kind === "health_check" ? "all" : "sample";
  const quota: SampleQuota | null = scope === "sample" ? quotaFor(options.sampleSize) : null;
  const seed = scope === "sample" ? (options.seed ?? newSeed()) : null;

  ctx.progress.phase("manifest");
  const record = await ctx.snapshots.latestCompleted(protectedObject.id);
  const {
    manifest,
    missing: manifestMissing,
    error: manifestError,
    cause: manifestCause,
  } = record
    ? await readManifest(ctx, record)
    : { manifest: null, missing: false, error: null, cause: null };
  if (manifestError) {
    logger.error(
      manifestMissing
        ? "manifest of the latest snapshot is gone from every storage target"
        : "manifest of the latest snapshot is unreadable",
      { snapshotId: record?.id, error: manifestError },
    );
    ctx.progress.fail(
      record?.manifestPath ?? protectedObject.id,
      `${manifestMissing ? "manifest missing" : "manifest unreadable"}: ${manifestError}`,
      manifestCause ?? undefined,
    );
  }

  const plan = !manifest
    ? EMPTY_PLAN
    : quota && seed !== null
      ? planSample(manifest.objects, quota, seededRandom(seed))
      : planFull(manifest.objects);

  ctx.progress.phase("read_back");
  ctx.progress.total(plan.items.length);
  const reader = new ChunkReader({
    storage: ctx.storage,
    keys: ctx.keys,
    index: ctx.chunkIndex,
    logger: ctx.logger,
    signal: ctx.signal,
  });
  const checks: ItemCheck[] = [];
  // The first read that proves nothing ends the read-back: the storage is not answering, and
  // asking it for every further item would only wait out the same failure again and again.
  let inconclusive: InconclusiveRead | null = null;
  for (const item of plan.items) {
    throwIfAborted(ctx.signal);
    const check = await checkObjectWithParts(reader, item.object, item.category, item.parts);
    if (check.status === "inconclusive") {
      inconclusive = check;
      logger.warn("an item could not be read back, the check cannot complete", {
        path: check.path,
        cause: check.cause.code,
        error: check.reason,
      });
      break;
    }
    checks.push(check);
    if (check.status === "verified") {
      ctx.progress.advance(1, check.bytesRead);
    } else {
      ctx.progress.fail(
        check.id ?? check.path,
        `${check.status}: ${check.reason ?? ""}`.trim(),
        check.cause,
      );
    }
  }

  const flagged = new Set([
    ...(options.damagedPacks ?? []),
    ...(options.unreadablePacks ?? []),
    ...(options.persistentlyUnreadablePacks ?? []),
  ]);
  const flaggedOfSnapshot = manifest
    ? await damagedPacksOfSnapshot(ctx.chunkIndex, manifest, flagged, ctx.signal)
    : [];
  const damagedPacks = flaggedOfSnapshot.filter((path) => options.damagedPacks?.has(path));
  const unreadablePacks = flaggedOfSnapshot
    .filter((path) => !options.damagedPacks?.has(path))
    .map((path) => ({
      path,
      persistent: options.persistentlyUnreadablePacks?.has(path) ?? false,
    }));
  // A read-back that could not complete gets no test restore: it would not change the outcome.
  const probed =
    record && options.probe && scope === "sample" && !inconclusive
      ? await runProbe(ctx, options.probe, protectedObject, record.id, plan, checks)
      : null;
  // Test-restore items that failed for a reason that proves nothing (throttling, a network
  // error, an unknown error) do not count as failed; they make the check incomplete.
  const inconclusiveProbe =
    probed?.items.filter(
      (item) => item.status === "failed" && !isTestRestoreEvidence(item.cause),
    ) ?? [];
  const testRestore = probed;

  const backupFailures =
    record && options.backupFailures ? await options.backupFailures(record) : null;
  const counts = tally(plan, checks);
  const content = manifest ? contentOf(manifest) : { bytes: 0, objects: 0 };
  const now = ctx.now();
  const assessment = assessReadiness(
    {
      hasSnapshot: record !== null,
      snapshotCompletedAt: record?.completedAt ?? null,
      manifestReadable: manifest !== null,
      manifestMissing,
      checked: counts.checked,
      contentBytes: content.bytes,
      contentObjects: content.objects,
      itemCount: manifest?.objects.length ?? 0,
      outcomes: counts,
      damagedPacks: damagedPacks.length,
      unreadablePacks: unreadablePacks.filter((pack) => !pack.persistent).length,
      persistentlyUnreadablePacks: unreadablePacks.filter((pack) => pack.persistent).length,
      testRestore: testRestore
        ? {
            failed:
              testRestore.items.filter((item) => item.status === "failed").length -
              inconclusiveProbe.length,
            unconfirmed: testRestore.items.filter((item) => item.status === "unconfirmed").length,
          }
        : null,
      backupFailures,
      source: sourceEvidence(manifest?.sourceSignal),
      now,
    },
    options.policy ?? DEFAULT_READINESS_POLICY,
  );

  // Incomplete unless something else already proves damage: a backup that is merely old,
  // or a warning, is no reason to rate a check that could not read the data.
  const proven = assessment.reasons.some(
    (reason) => reason.severity === "red" && reason.code !== "snapshot_outdated",
  );
  if (!proven && (inconclusive || inconclusiveProbe.length > 0)) {
    const first = inconclusiveProbe[0];
    throw inconclusive
      ? new VerifyIncompleteError(
          `${inconclusive.path} could not be read back (${inconclusive.reason})`,
          inconclusive.cause,
        )
      : new VerifyIncompleteError(
          `the test restore of ${first?.path ?? "the sample"} did not complete (${first?.reason ?? "no reason given"})`,
          first?.cause ?? buildCause("verify.incomplete"),
        );
  }

  const listed = listedItems(checks, scope);
  const details: VerifyReportDetails = {
    format: READINESS_REPORT_FORMAT,
    origin: "verify",
    kind: options.kind,
    scope,
    seed,
    quota,
    snapshot: record ? snapshotRef(record, manifest) : null,
    reasons: assessment.reasons,
    ...(manifestCause ? { manifestCause } : {}),
    counts,
    items: listed.items,
    itemsOmitted: listed.omitted,
    damagedPacks,
    ...(unreadablePacks.length > 0 ? { unreadablePacks } : {}),
    testRestore,
    startedAt: startedAt.toISOString(),
    durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
  };
  logger.info("verify finished", {
    readiness: assessment.readiness,
    reasons: assessment.reasons.map((reason) => reason.code),
    checked: counts.checked,
    verified: counts.verified,
  });
  return {
    readiness: assessment.readiness,
    checked: counts.checked,
    mismatched: counts.mismatch,
    // Unreadable items are as lost to a restore as missing ones.
    missing: counts.missing + counts.unreadable,
    snapshotId: record?.id ?? null,
    details,
  };
}

/** Checks of one backup in a row that could not complete before it is no longer rated by an older check. */
export const INCOMPLETE_CHECKS_LIMIT = 3;

/**
 * The outcome the worker records for a backup whose last {@link INCOMPLETE_CHECKS_LIMIT}
 * checks could not complete (the storage did not answer): yellow `check_incomplete`, nothing
 * read. It replaces the backup's earlier rating, so an old green stops counting as proof
 * while nobody can read the backup; the next check that completes rates it again.
 */
export function unverifiedOutcome(input: {
  readonly record: SnapshotRecord;
  readonly kind: VerifyRunOptions["kind"];
  /** Checks in a row that could not complete, this one included. */
  readonly incompleteChecks: number;
  readonly startedAt: Date;
  readonly now: Date;
}): VerifyOutcome {
  const plan = EMPTY_PLAN;
  const counts = tally(plan, []);
  const details: VerifyReportDetails = {
    format: READINESS_REPORT_FORMAT,
    origin: "verify",
    kind: input.kind,
    scope: input.kind === "health_check" ? "all" : "sample",
    seed: null,
    quota: null,
    snapshot: snapshotRef(input.record, null),
    reasons: [{ code: "check_incomplete", severity: "yellow", count: input.incompleteChecks }],
    counts,
    items: [],
    itemsOmitted: 0,
    damagedPacks: [],
    testRestore: null,
    startedAt: input.startedAt.toISOString(),
    durationMs: Math.max(0, input.now.getTime() - input.startedAt.getTime()),
  };
  return {
    readiness: "yellow",
    checked: 0,
    mismatched: 0,
    missing: 0,
    snapshotId: input.record.id,
    details,
  };
}
