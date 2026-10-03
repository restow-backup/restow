/**
 * The `storage_migration` queue handler: replaces a tenant's primary storage
 * target with a newly added one (docs/STORAGE.md, "Replace the primary").
 *
 * Only the `move` mode ever reaches here — `apps/api/src/features/storage/
 * service.ts`'s `startReplacePrimaryTx` switches `keep` synchronously in the
 * API when the target is created, since nothing needs copying, so a "keep"
 * request never queues this job. For `move` the destination target already
 * exists as a live `copy` (new backups replicate to it from the moment it was
 * added), so this job only has to backfill what existed before that:
 *
 *   1. `copying` — every pack, manifest and wrapped key the primary holds,
 *      written to the destination and checked by size (cheap; a full hash
 *      compare happens once for everything in the next phase). Resumable: the
 *      job checkpoints the last key done in `jobs.cursor`, so a crash or a
 *      pg-boss retry continues instead of starting over. Throttled on
 *      purpose — one object at a time, with a short pause between them — so a
 *      large backfill does not starve the disk or network the tenant's
 *      running backups and restores also use. A per-object I/O failure (a
 *      timeout, a dropped connection) is retried a few times before it counts
 *      against the migration, so one transient hiccup never fails the whole
 *      run.
 *   2. `verifying` — a second, independent pass over every object, this time
 *      reading both sides back and comparing SHA-256 (also checkpointed, so a
 *      resumed verification does not re-hash what it already confirmed). Any
 *      mismatch or missing object fails the migration outright: the switch
 *      never happens and the old primary keeps serving reads and writes.
 *   3. reconciliation — right before the switch, the item list is rebuilt
 *      from the source and re-diffed against what has been verified so far.
 *      A backup already running when the target was added, or one that
 *      started in the few minutes the worker's storage cache takes to notice
 *      the new target, writes only to the old primary; without this step the
 *      switch could retire a primary that still held packs the destination
 *      never received. New items found this way are copied and verified too,
 *      and while a backup or archive job of the tenant is still active the
 *      switch waits and looks again, up to a bound; past that the job ends
 *      (without failing the migration) so pg-boss retries it later.
 *   4. `switching` — one atomic transaction: the destination becomes `primary`,
 *      the old primary (a target row, or a fresh placeholder standing for the
 *      installation default) becomes `previous` — read-only from then on,
 *      kept until an admin removes it.
 *
 * A tenant that chose "keep existing backups where they are" for an earlier
 * replacement may still have packs that live only on that retired `previous`
 * target. Reading the source for this job (steps 1–3) therefore falls back to
 * every `previous` target of the tenant, read-only, after the primary source
 * (core `readOnlyFallbackChain`): a `move` that follows an earlier `keep`
 * copies those older packs across too, instead of reporting them missing.
 *
 * Garbage collection yields to an active migration exactly as it yields to a
 * running backup, restore or verify (apps/worker/src/handlers/scrub.ts,
 * `activeMigrationBlocksGc`): the packs this job reads and writes must still
 * be there when it checks them.
 *
 * Abort handling distinguishes why the run stopped (`abortReasonOf`, shared
 * with every other handler):
 *   - an admin's cancel request finishes the migration as `cancelled` right
 *     here, with its own audit entry, and the framework then records the
 *     `jobs` row as cancelled too.
 *   - a graceful worker shutdown or a pg-boss lease about to expire is not a
 *     cancellation: the checkpoint already taken is all that happens, the
 *     migration row is left exactly as it was, and the framework's own retry
 *     resumes this handler from that checkpoint.
 * A verification mismatch or an unrecoverable copy failure marks the
 * migration `failed` and rejects the job without retrying (pg-boss trying the
 * same mismatch again would not fix it); a migration whose job later fails
 * for good some other way (an unreachable destination, exhausted retries) is
 * reconciled by `apps/api/src/features/storage/service.ts`'s cancel action,
 * which finalizes a migration whose job is no longer running.
 */
import {
  type MirrorItem,
  type MirrorItemResult,
  type StorageBackend,
  type StorageMigrationJobPayload,
  type StorageTargets,
  destinationObjectKeys,
  metadataMirrorItems,
  mirrorItem,
  openStorageTarget,
  packMirrorItems,
  parseManifestKey,
  readOnlyFallbackChain,
  resolveStorageTargets,
} from "@restow/core";
import {
  type Database,
  type Job,
  type StorageMigration,
  type StorageTarget,
  jobs,
  packs,
  snapshots,
  storageMigrations,
  storageTargets,
} from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import { processDefaultStorage } from "../default-storage.js";
import type { TenantTx, TenantTxRunner } from "../progress.js";
import {
  type AbortReason,
  InvalidPayloadError,
  type JobHandler,
  type JobOutcome,
  type WorkerJobContext,
  abortReasonOf,
  tenantRunner,
} from "./framework.js";

/**
 * Duplicated verbatim from `STORAGE_AUDIT_ACTIONS` in
 * apps/api/src/features/storage/service.ts (the api and worker processes
 * share no code across the app boundary) — keep the two in lock-step.
 */
const AUDIT_ACTIONS = {
  verifyFailed: "storage.migration.verify_failed",
  switched: "storage.migration.switched",
  cancelled: "storage.migration.cancelled",
} as const;

/** `storage_migrations.status` values a migration is still in flight under. */
const UNFINISHED_STATUSES: readonly StorageMigration["status"][] = [
  "queued",
  "copying",
  "verifying",
  "switching",
];

/** Queues a running job of which must finish (or be waited out) before the switch. */
const BACKUP_QUEUES = ["backup", "archive"] as const;

/** Items between checkpoints, and the pause between objects (throttling). */
const CHECKPOINT_EVERY = 25;
const THROTTLE_DELAY_MS = 20;
/** Sample of failing keys kept in the error message; the rest is just a count. */
const MAX_REPORTED_PROBLEMS = 10;
/** A per-object failure (not a hash/size mismatch) is retried this many times before it counts. */
const TRANSIENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_RETRY_DELAY_MS = 250;
/**
 * Consecutive plain I/O failures (`mirrorItem`'s `"failed"`, each already
 * retried `TRANSIENT_RETRY_ATTEMPTS` times) that stop a pass early: this many
 * objects in a row failing to even connect means the destination itself is
 * unreachable, not that a handful of objects happen to be having a bad day.
 * Continuing through every remaining item at the same doomed rate would waste
 * hours of retries before the migration fails anyway (each attempt already
 * costs up to `TRANSIENT_RETRY_ATTEMPTS` tries with a growing pause). A
 * mismatch outcome (`source_missing`, `source_corrupt`, `verify_failed`) does
 * not count here: those are facts about one object's data, not a reachability
 * signal, and stopping early on them would hide problems the report should
 * list in full.
 */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Reconciliation rounds (see the file doc comment) before the job ends and pg-boss retries later. */
const RECONCILE_MAX_ROUNDS = 20;
const RECONCILE_WAIT_MS = 3_000;

/**
 * How long every worker process's tenant storage cache (apps/worker/src/
 * handlers/framework.ts, `TenantCache`'s default TTL, currently 5 minutes —
 * shared by the keyring and storage caches) may take to notice a target added
 * after it last resolved the tenant's storage. The switch below waits this
 * long, measured from the destination's `createdAt`, before retiring the old
 * primary: a worker whose cache is still from before the destination existed
 * resolves `StorageTargets` with no `copies` entry for it, so a backup that
 * starts on it writes only to the old primary — which is about to become the
 * read-only `previous` target — and that write would then be unreadable by
 * anything going forward.
 *
 * Duplicated here rather than imported: the worker's queue handlers share no
 * code across the api/worker app boundary beyond `@restow/core`, and this
 * constant lives in `apps/worker/src/handlers/framework.ts`. A change to the
 * cache TTL there must be mirrored here by hand until the two are unified.
 *
 * This bound only protects the window *before* the switch. For up to the same
 * TTL *after* it, a worker process whose cache predates the switch can still
 * resolve the retired target as `primary`: a backup, `mirrorTenantKeys` or a
 * scrub run that started on such a cache can write to, or garbage-collect,
 * what is now the read-only `previous` target. No data is lost by this (the
 * destination already holds a verified copy of everything by the time the
 * switch commits), but it is a real gap in "never written to" for that short
 * window; closing it needs the storage cache to notice the switch instead of
 * only expiring on a timer, e.g. by keying it off `storage_targets.updated_at`
 * rather than a fixed TTL.
 *
 * Overridable through `RESTOW_STORAGE_CACHE_SETTLE_MS` for tests, which have
 * no 5-minute-old destination row to wait out.
 */
const DEFAULT_STORAGE_CACHE_SETTLE_MS = 6 * 60 * 1000;

function storageCacheSettleMs(): number {
  const raw = process.env.RESTOW_STORAGE_CACHE_SETTLE_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STORAGE_CACHE_SETTLE_MS;
}

/** Milliseconds still to wait for worker storage caches to settle, or 0 once they have. */
function msUntilStorageCacheSettled(now: Date, destinationCreatedAt: Date): number {
  return Math.max(0, storageCacheSettleMs() - (now.getTime() - destinationCreatedAt.getTime()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MigrationCursor {
  readonly phase: "copying" | "verifying";
  /** The sorted item list's last key fully done; items up to it are skipped on resume. */
  readonly lastKey: string | null;
}

function isMigrationCursor(value: unknown): value is MigrationCursor {
  const phase = (value as { phase?: unknown } | null)?.phase;
  return phase === "copying" || phase === "verifying";
}

/** `jobs.status` values after which nothing about that job runs again. */
const TERMINAL_JOB_STATUSES: readonly Job["status"][] = ["completed", "failed", "cancelled"];

/**
 * Whether a tenant has a `storage_migrations` row still in flight *and*
 * actually moving something: a row whose own status has not been
 * reconciled yet but whose background job already ended for good (exhausted
 * its retries, was never created) or is missing is not copying or verifying
 * anything any more, so it must not block collection forever (see this
 * module's doc comment, "a migration whose job later fails for good", and
 * `apps/api/src/features/storage/dto.ts`'s `stalled` projection, which
 * surfaces the same condition to the UI). Used by scrub.ts to yield garbage
 * collection to a migration, the same way it yields to a running backup,
 * restore or verify.
 */
export async function hasActiveMigration(run: TenantTxRunner, tenantId: string): Promise<boolean> {
  const rows = await run((tx) =>
    tx
      .select({ jobId: storageMigrations.jobId, jobStatus: jobs.status })
      .from(storageMigrations)
      .leftJoin(
        jobs,
        and(eq(jobs.id, storageMigrations.jobId), eq(jobs.tenantId, storageMigrations.tenantId)),
      )
      .where(
        and(
          eq(storageMigrations.tenantId, tenantId),
          inArray(storageMigrations.status, UNFINISHED_STATUSES),
        ),
      ),
  );
  return rows.some(
    (row) => !row.jobId || !row.jobStatus || !TERMINAL_JOB_STATUSES.includes(row.jobStatus),
  );
}

/** Whether a backup or archive sync of the tenant is currently running. */
async function hasActiveBackupJob(run: TenantTxRunner, tenantId: string): Promise<boolean> {
  const [row] = await run((tx) =>
    tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          inArray(jobs.queue, [...BACKUP_QUEUES]),
          eq(jobs.status, "active"),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

async function loadMigration(
  run: TenantTxRunner,
  tenantId: string,
  id: string,
): Promise<StorageMigration | null> {
  const [row] = await run((tx) =>
    tx
      .select()
      .from(storageMigrations)
      .where(and(eq(storageMigrations.tenantId, tenantId), eq(storageMigrations.id, id)))
      .limit(1),
  );
  return row ?? null;
}

async function loadTenantTargets(run: TenantTxRunner, tenantId: string): Promise<StorageTarget[]> {
  return run((tx) => tx.select().from(storageTargets).where(eq(storageTargets.tenantId, tenantId)));
}

async function setMigration(
  run: TenantTxRunner,
  tenantId: string,
  id: string,
  changes: Partial<typeof storageMigrations.$inferInsert>,
): Promise<void> {
  await run((tx) =>
    tx
      .update(storageMigrations)
      .set(changes)
      .where(and(eq(storageMigrations.tenantId, tenantId), eq(storageMigrations.id, id))),
  );
}

/** The tenant's current `snapshots.id`s, to tell a pruned manifest apart from a missing one. */
async function liveSnapshotIds(run: TenantTxRunner, tenantId: string): Promise<Set<string>> {
  const rows = await run((tx) =>
    tx.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.tenantId, tenantId)),
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Whether `key` is a committed manifest whose `snapshots` row is gone: daily
 * retention (apps/worker/src/handlers/retention.ts) prunes a snapshot and its
 * manifest file together, and a run of it can overlap a multi-hour migration
 * of a large tenant. Such a manifest is expected to be missing on the source,
 * not evidence of damage, so it must not fail the whole migration (`runPass`)
 * or even be attempted in the first place (`buildItemList`).
 */
function isPrunedManifest(key: string, live: ReadonlySet<string>): boolean {
  const parsed = parseManifestKey(key);
  return parsed !== null && !parsed.partial && !live.has(parsed.snapshotId);
}

/** The full, deterministically ordered item list for one migration (metadata first, then packs, both by key). */
async function buildItemList(
  run: TenantTxRunner,
  tenantId: string,
  source: StorageBackend,
): Promise<MirrorItem[]> {
  const [packRows, live, metadata] = await Promise.all([
    run((tx) =>
      tx
        .select({ path: packs.path, size: packs.size, sha256: packs.sha256 })
        .from(packs)
        .where(eq(packs.tenantId, tenantId)),
    ),
    liveSnapshotIds(run, tenantId),
    metadataMirrorItems(tenantId, source),
  ]);
  // Retention may already have pruned a manifest this listing still shows
  // (its DB row is gone, but the delete of the file itself is not the same
  // transaction): drop it now rather than report it "source_missing" later.
  const items = [
    ...metadata.filter((item) => !isPrunedManifest(item.key, live)),
    ...packMirrorItems(packRows),
  ];
  return items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function remainingItems(
  items: readonly MirrorItem[],
  cursor: MigrationCursor | null,
): MirrorItem[] {
  if (!cursor?.lastKey) {
    return [...items];
  }
  return items.filter((item) => item.key > (cursor.lastKey as string));
}

/**
 * `remainingItems`, but corrected for a resumed pass: a checkpoint only ever
 * means "every item at or below this key, from the list this job had at the
 * time, is confirmed on the destination" — never "every item at or below
 * this key in whatever list a later execution rebuilds". Between two
 * executions the source can gain a manifest or a pack that sorts at or below
 * `cursor.lastKey` (a new manifest always does, since "manifests/" sorts
 * before "packs/"; a new pack does whenever its random shard prefix lands
 * low) without the checkpoint ever having accounted for it. Trusting the
 * checkpoint for such an item would skip mirroring it entirely, and once
 * this migration switches the primary that object becomes unreachable from
 * every storage target the worker still reads (the file doc comment,
 * "3. reconciliation").
 *
 * A listing-only check against the destination (cheap: no reads, `MirrorItem`
 * only ever advances a checkpoint's key past an object once that object is
 * confirmed there) tells a real gap apart from one this pass has simply not
 * reached yet: anything at or below the checkpoint that is missing from the
 * destination is added back to what this pass processes. Repeated on every
 * resume, so an aborted attempt at closing a gap is retried from a fresh
 * listing rather than relying on the checkpoint to remember it.
 */
async function resumablePending(
  tenantId: string,
  destination: StorageBackend,
  items: readonly MirrorItem[],
  cursor: MigrationCursor | null,
): Promise<MirrorItem[]> {
  const tail = remainingItems(items, cursor);
  const floor = cursor?.lastKey;
  if (!floor) {
    return tail;
  }
  const onDestination = await destinationObjectKeys(tenantId, destination);
  const gaps = items.filter((item) => item.key <= floor && !onDestination.has(item.key));
  if (gaps.length === 0) {
    return tail;
  }
  return [...gaps, ...tail].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * `mirrorItem`, retrying a plain I/O failure (`"failed"`, e.g. a timeout or a
 * dropped connection) a few times before it counts. A hash/size mismatch
 * (`source_corrupt`, `verify_failed`) is never retried: rereading the same
 * bytes would not change the answer.
 */
async function mirrorWithRetry(
  options: { source: StorageBackend; target: StorageBackend; verify: "size" | "hash" },
  item: MirrorItem,
): Promise<MirrorItemResult> {
  let outcome = await mirrorItem({ ...options, items: [] }, item);
  for (
    let attempt = 1;
    outcome.outcome === "failed" && attempt < TRANSIENT_RETRY_ATTEMPTS;
    attempt++
  ) {
    await sleep(TRANSIENT_RETRY_DELAY_MS * attempt);
    outcome = await mirrorItem({ ...options, items: [] }, item);
  }
  return outcome;
}

interface PassOutcome {
  readonly aborted: boolean;
  readonly bytesWritten: number;
  readonly problems: readonly MirrorItemResult[];
  readonly problemsOmitted: number;
  /** Manifests retention pruned while this pass was running (see `isPrunedManifest`). */
  readonly skippedPruned: number;
  /** True when this pass gave up after `MAX_CONSECUTIVE_FAILURES`, leaving items unattempted. */
  readonly stoppedEarly: boolean;
}

/**
 * Drive one pass (copying or verifying) over `items`, checkpointing progress
 * and honouring an abort between objects. Sequential and paced on purpose —
 * see the file doc comment on throttling.
 */
async function runPass(options: {
  readonly ctx: WorkerJobContext;
  readonly run: TenantTxRunner;
  readonly migration: StorageMigration;
  readonly items: readonly MirrorItem[];
  readonly cursor: MigrationCursor | null;
  readonly phase: MigrationCursor["phase"];
  readonly source: StorageBackend;
  readonly destination: StorageBackend;
  readonly verify: "size" | "hash";
  /**
   * How many passes `ctx.progress` (one tracker for this whole job
   * execution, its `done` accumulating across phases) will see before this
   * execution ends: 2 when copying runs before verifying in the same
   * execution, 1 when this execution resumes straight into verifying because
   * copying already finished in an earlier attempt. Sets the tracker's
   * `total` to what `done` will actually reach, so its ETA (`job_progress.
   * eta_seconds`) reflects every pass this execution still has left instead
   * of reading "0 s left" once `done` from an earlier phase already exceeds
   * a `total` sized for one phase alone.
   */
  readonly passesInThisRun: 1 | 2;
}): Promise<PassOutcome> {
  const { ctx, run, migration, items, phase, source, destination, verify, passesInThisRun } =
    options;
  const resumeCursor = options.cursor?.phase === phase ? options.cursor : null;
  const pending = await resumablePending(ctx.tenantId, destination, items, resumeCursor);
  const alreadyDone = items.length - pending.length;
  let done = alreadyDone;
  let bytesWritten = 0;
  const problems: MirrorItemResult[] = [];
  let problemsOmitted = 0;
  let skippedPruned = 0;
  let sinceCheckpoint = 0;
  let consecutiveFailures = 0;
  // The checkpoint never regresses below what an earlier execution already
  // confirmed: `pending` can now start with gap items at or below this floor
  // (resumablePending, above), and processing those must not make the saved
  // `lastKey` look smaller than it already durably was.
  const checkpointFloor = resumeCursor?.lastKey ?? null;
  let lastKey: string | null = checkpointFloor;
  // Only fetched once a manifest actually comes back "source_missing" (rare):
  // retention's own timing, not this pass's, decides whether that happens at all.
  let liveAtSourceMissing: Set<string> | null = null;

  ctx.progress.phase(phase);
  ctx.progress.total(items.length * passesInThisRun);
  if (alreadyDone > 0) {
    ctx.progress.advance(alreadyDone, 0);
  }
  await setMigration(run, ctx.tenantId, migration.id, {
    objectsDone: done,
    objectsTotal: items.length,
  });

  for (const item of pending) {
    if (ctx.signal.aborted) {
      await ctx.cursor.save({ phase, lastKey });
      return {
        aborted: true,
        bytesWritten,
        problems,
        problemsOmitted,
        skippedPruned,
        stoppedEarly: false,
      };
    }
    const outcome = await mirrorWithRetry({ source, target: destination, verify }, item);
    bytesWritten += outcome.bytesWritten;
    done++;
    // A gap item (at or below `checkpointFloor`) never moves `lastKey`: it is
    // re-discovered fresh from the destination's own listing on every
    // resume (resumablePending), so the saved checkpoint has nothing to gain
    // from tracking it, and must not appear to regress if this pass is cut
    // short right after processing one.
    if (checkpointFloor === null || item.key > checkpointFloor) {
      lastKey = item.key;
    }
    sinceCheckpoint++;
    if (
      outcome.outcome === "present" ||
      outcome.outcome === "copied" ||
      outcome.outcome === "repaired"
    ) {
      consecutiveFailures = 0;
      ctx.progress.advance(1, outcome.bytesWritten);
    } else if (outcome.outcome === "source_missing" && parseManifestKey(item.key) !== null) {
      // liveAtSourceMissing is loaded once, lazily, and reused for the rest
      // of this pass: retention prunes in its own sweep, not continuously,
      // so one fresh read covers every manifest this pass still has to look at.
      liveAtSourceMissing ??= await liveSnapshotIds(run, ctx.tenantId);
      if (isPrunedManifest(item.key, liveAtSourceMissing)) {
        ctx.logger.info("storage migration: source manifest was pruned by retention, skipping it", {
          key: item.key,
          phase,
        });
        skippedPruned++;
        consecutiveFailures = 0;
        ctx.progress.advance(1, 0);
      } else {
        consecutiveFailures = 0; // a fact about this object's data, not a reachability signal
        ctx.progress.fail(item.key, outcome.detail ?? outcome.outcome, outcome.cause);
        if (problems.length < MAX_REPORTED_PROBLEMS) {
          problems.push(outcome);
        } else {
          problemsOmitted++;
        }
      }
    } else {
      consecutiveFailures = outcome.outcome === "failed" ? consecutiveFailures + 1 : 0;
      ctx.progress.fail(item.key, outcome.detail ?? outcome.outcome, outcome.cause);
      if (problems.length < MAX_REPORTED_PROBLEMS) {
        problems.push(outcome);
      } else {
        problemsOmitted++;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // The destination (or, for a "keep" then "move", a previous target)
        // looks unreachable rather than merely having a bad object: stop
        // here instead of retrying every remaining item at the same doomed
        // rate, which on a large tenant could mean hours of futile I/O
        // before the migration failed anyway.
        ctx.logger.warn(
          "storage migration: stopping this pass early after consecutive failures, the destination looks unreachable",
          { phase, consecutiveFailures, lastKey },
        );
        await ctx.cursor.save({ phase, lastKey });
        await setMigration(run, ctx.tenantId, migration.id, {
          objectsDone: done,
          bytesDone: bytesWritten,
        });
        return {
          aborted: false,
          bytesWritten,
          problems,
          problemsOmitted,
          skippedPruned,
          stoppedEarly: true,
        };
      }
    }
    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      await ctx.cursor.save({ phase, lastKey });
      await setMigration(run, ctx.tenantId, migration.id, {
        objectsDone: done,
        bytesDone: bytesWritten,
      });
      sinceCheckpoint = 0;
    }
    await sleep(THROTTLE_DELAY_MS);
  }
  await ctx.cursor.save({ phase, lastKey });
  await setMigration(run, ctx.tenantId, migration.id, {
    objectsDone: done,
    bytesDone: bytesWritten,
  });
  return {
    aborted: false,
    bytesWritten,
    problems,
    problemsOmitted,
    skippedPruned,
    stoppedEarly: false,
  };
}

function problemSummary(
  outcome: Pick<PassOutcome, "problems" | "problemsOmitted" | "stoppedEarly">,
  phase: string,
): string {
  const sample = outcome.problems.map((p) => `${p.key} (${p.outcome})`).join(", ");
  const omitted = outcome.problemsOmitted > 0 ? `, +${outcome.problemsOmitted} more` : "";
  const stoppedNote = outcome.stoppedEarly
    ? " Stopped after repeated failures in a row instead of trying every remaining object; the destination may be unreachable."
    : "";
  return `${phase} found ${outcome.problems.length + outcome.problemsOmitted} object(s) that did not verify: ${sample}${omitted}${stoppedNote}`;
}

async function auditMigration(
  tx: TenantTx,
  tenantId: string,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await appendAuditEntry(tx, {
    tenantId,
    actor: "system",
    action,
    target: targetId,
    targetType: "storage_target",
    details,
  });
}

/** Persist the migration as cancelled, with its own audit entry (an admin's cancel request only). */
async function persistCancelled(
  run: TenantTxRunner,
  ctx: WorkerJobContext,
  migration: StorageMigration,
): Promise<void> {
  await run(async (tx) => {
    await tx
      .update(storageMigrations)
      .set({ status: "cancelled", finishedAt: ctx.now() })
      .where(
        and(eq(storageMigrations.tenantId, ctx.tenantId), eq(storageMigrations.id, migration.id)),
      );
    await auditMigration(tx, ctx.tenantId, AUDIT_ACTIONS.cancelled, migration.destinationTargetId, {
      migrationId: migration.id,
      duringWorkerRun: true,
    });
  });
}

/**
 * What to do when `ctx.signal` fired, distinguishing why (`abortReasonOf`,
 * shared with every handler): an admin's cancel request finishes the
 * migration right here (its `jobs` row is finished by the framework, once
 * this throws); a graceful shutdown or an expiring lease is not a
 * cancellation, so the migration row is left exactly as it is and only the
 * checkpoint the caller already saved carries over into the framework's own
 * retry. Either way this never returns: the framework decides the job's
 * outcome from the thrown error and `ctx.signal`'s reason.
 */
async function handleAbort(
  run: TenantTxRunner,
  ctx: WorkerJobContext,
  migration: StorageMigration,
): Promise<never> {
  const reason: AbortReason | null = abortReasonOf(ctx.signal);
  if (reason === "cancelled") {
    await persistCancelled(run, ctx, migration);
  }
  throw new StorageMigrationAbortedError(reason ?? "shutdown");
}

/** Marks a run that stopped because `ctx.signal` fired; carries no payload beyond the reason. */
class StorageMigrationAbortedError extends Error {
  constructor(readonly reason: AbortReason) {
    super(`storage migration interrupted (${reason})`);
    this.name = "StorageMigrationAbortedError";
  }
}

async function failMigration(
  run: TenantTxRunner,
  ctx: WorkerJobContext,
  migration: StorageMigration,
  reason: string,
): Promise<void> {
  await run(async (tx) => {
    await tx
      .update(storageMigrations)
      .set({ status: "failed", errorMessage: reason, finishedAt: ctx.now() })
      .where(
        and(eq(storageMigrations.tenantId, ctx.tenantId), eq(storageMigrations.id, migration.id)),
      );
    await auditMigration(
      tx,
      ctx.tenantId,
      AUDIT_ACTIONS.verifyFailed,
      migration.destinationTargetId,
      {
        migrationId: migration.id,
        reason,
      },
    );
  });
}

/**
 * Persist the migration as failed and reject the job without retrying
 * (`InvalidPayloadError`, the framework's convention for "this will not
 * succeed on a retry", also used by backup.ts and directory.ts): a hash or
 * size mismatch, or a copy that cannot be repaired, is a fact about the data,
 * not a transient condition pg-boss's retry would resolve.
 */
async function rejectMigration(
  run: TenantTxRunner,
  ctx: WorkerJobContext,
  migration: StorageMigration,
  reason: string,
): Promise<never> {
  await failMigration(run, ctx, migration, reason);
  throw new InvalidPayloadError(reason);
}

/** Bytes a finished item list actually takes: recorded pack sizes, or the destination's for metadata. */
async function totalBytesOf(
  items: readonly MirrorItem[],
  destination: StorageBackend,
): Promise<number> {
  let total = 0;
  for (const item of items) {
    if (item.size !== null) {
      total += item.size;
      continue;
    }
    const head = await destination.head(item.key).catch(() => null);
    total += head?.size ?? 0;
  }
  return total;
}

/**
 * The switch is refused (the migration failed instead) when either row moved
 * out from under it since the job opened its storage backends: the source is
 * no longer the primary (an admin promoted a different copy while this ran —
 * `rules.ts`'s migration-in-progress guard should have prevented that, this
 * is the defense in depth for a race it might still miss), or the
 * destination's stored addressing no longer matches what this job copied
 * everything to (an admin edited it mid-migration).
 */
type SwitchPreconditionFailure = "source_not_primary" | "destination_changed";

function switchPreconditionFailure(
  freshSource: StorageTarget | null,
  freshDestination: StorageTarget | null,
  expected: { sourceRole: StorageTarget["role"] | null; destinationConfig: unknown },
): SwitchPreconditionFailure | null {
  if (expected.sourceRole !== null && freshSource?.role !== expected.sourceRole) {
    return "source_not_primary";
  }
  if (
    !freshDestination ||
    JSON.stringify(freshDestination.config) !== JSON.stringify(expected.destinationConfig)
  ) {
    return "destination_changed";
  }
  return null;
}

/**
 * The atomic switch: destination becomes primary, the old one becomes
 * `previous` (inserting a placeholder first when it was the installation
 * default, which has no row of its own). Re-checks both rows fresh, inside
 * this same transaction, before touching anything (see
 * {@link switchPreconditionFailure}).
 */
async function switchPrimary(
  run: TenantTxRunner,
  ctx: WorkerJobContext,
  migration: StorageMigration,
  sourceRow: StorageTarget | null,
  destinationId: string,
  destinationConfigAtOpen: unknown,
  totals: { objectsTotal: number; bytesTotal: number },
): Promise<SwitchPreconditionFailure | null> {
  return run(async (tx) => {
    const [freshSource, freshDestination] = await Promise.all([
      sourceRow
        ? tx
            .select()
            .from(storageTargets)
            .where(
              and(eq(storageTargets.tenantId, ctx.tenantId), eq(storageTargets.id, sourceRow.id)),
            )
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      tx
        .select()
        .from(storageTargets)
        .where(and(eq(storageTargets.tenantId, ctx.tenantId), eq(storageTargets.id, destinationId)))
        .then((rows) => rows[0] ?? null),
    ]);
    const failure = switchPreconditionFailure(freshSource, freshDestination, {
      sourceRole: sourceRow ? "primary" : null,
      destinationConfig: destinationConfigAtOpen,
    });
    if (failure) {
      return failure;
    }
    let sourceTargetId = migration.sourceTargetId;
    if (sourceRow) {
      await tx
        .update(storageTargets)
        .set({ role: "previous" })
        .where(and(eq(storageTargets.tenantId, ctx.tenantId), eq(storageTargets.id, sourceRow.id)));
    } else if (sourceTargetId === null) {
      const [placeholder] = await tx
        .insert(storageTargets)
        .values({
          tenantId: ctx.tenantId,
          name: null,
          kind: "installation_default",
          role: "previous",
          config: {},
        })
        .returning({ id: storageTargets.id });
      sourceTargetId = placeholder?.id ?? null;
    }
    await tx
      .update(storageTargets)
      .set({ role: "primary" })
      .where(and(eq(storageTargets.tenantId, ctx.tenantId), eq(storageTargets.id, destinationId)));
    const now = ctx.now();
    await tx
      .update(storageMigrations)
      .set({
        status: "completed",
        sourceTargetId,
        objectsTotal: totals.objectsTotal,
        objectsDone: totals.objectsTotal,
        bytesTotal: totals.bytesTotal,
        bytesDone: totals.bytesTotal,
        switchedAt: now,
        finishedAt: now,
      })
      .where(
        and(eq(storageMigrations.tenantId, ctx.tenantId), eq(storageMigrations.id, migration.id)),
      );
    await auditMigration(tx, ctx.tenantId, AUDIT_ACTIONS.switched, destinationId, {
      migrationId: migration.id,
      previousPrimary: sourceTargetId,
      objectsTotal: totals.objectsTotal,
      bytesTotal: totals.bytesTotal,
    });
    return null;
  });
}

/**
 * Reconciliation: right before the switch, keep rebuilding the item list from
 * the source and mirroring whatever is new, until a round finds nothing new
 * and no backup or archive job of the tenant is running any more (see the
 * file doc comment). Returns the final item list and the reconciled keys'
 * total bytes; throws `StorageMigrationAbortedError` on an abort and rejects
 * the migration (no retry) on a verification problem. Gives up after
 * `RECONCILE_MAX_ROUNDS` without a plain, retryable error, so pg-boss tries
 * again later rather than pinning a worker slot indefinitely on a tenant with
 * a very long-running backup.
 */
async function reconcileBeforeSwitch(
  run: TenantTxRunner,
  ctx: WorkerJobContext,
  migration: StorageMigration,
  source: StorageBackend,
  destination: StorageBackend,
  verifiedItems: readonly MirrorItem[],
): Promise<{ items: MirrorItem[]; bytesWritten: number }> {
  const seenKeys = new Set(verifiedItems.map((item) => item.key));
  let items = [...verifiedItems];
  let bytesWritten = 0;

  for (let round = 0; round < RECONCILE_MAX_ROUNDS; round++) {
    if (ctx.signal.aborted) {
      await handleAbort(run, ctx, migration);
    }
    const fresh = await buildItemList(run, ctx.tenantId, source);
    const newItems = fresh.filter((item) => !seenKeys.has(item.key));
    items = fresh;
    if (newItems.length === 0) {
      if (!(await hasActiveBackupJob(run, ctx.tenantId))) {
        return { items, bytesWritten };
      }
      await sleep(RECONCILE_WAIT_MS);
      continue;
    }
    ctx.progress.total(fresh.length);
    const problems: MirrorItemResult[] = [];
    let problemsOmitted = 0;
    for (const item of newItems) {
      if (ctx.signal.aborted) {
        await handleAbort(run, ctx, migration);
      }
      const outcome = await mirrorWithRetry({ source, target: destination, verify: "hash" }, item);
      bytesWritten += outcome.bytesWritten;
      seenKeys.add(item.key);
      if (
        outcome.outcome === "present" ||
        outcome.outcome === "copied" ||
        outcome.outcome === "repaired"
      ) {
        ctx.progress.advance(1, outcome.bytesWritten);
      } else {
        ctx.progress.fail(item.key, outcome.detail ?? outcome.outcome, outcome.cause);
        if (problems.length < MAX_REPORTED_PROBLEMS) {
          problems.push(outcome);
        } else {
          problemsOmitted++;
        }
      }
      await sleep(THROTTLE_DELAY_MS);
    }
    if (problems.length > 0 || problemsOmitted > 0) {
      await rejectMigration(
        run,
        ctx,
        migration,
        problemSummary(
          { problems, problemsOmitted, stoppedEarly: false },
          "Verifying (reconciliation)",
        ),
      );
    }
    await setMigration(run, ctx.tenantId, migration.id, {
      objectsTotal: fresh.length,
      objectsDone: seenKeys.size,
    });
  }
  // Still converging after RECONCILE_MAX_ROUNDS (a very active tenant): end
  // this attempt without touching the migration row, so pg-boss retries it —
  // the checkpoint from the last full pass still stands, and this
  // reconciliation itself is idempotent (mirrorItem no-ops on what is already
  // there), so the retry picks up quickly rather than repeating real work.
  throw new Error(
    `storage migration ${migration.id}: still reconciling new backup data after ${RECONCILE_MAX_ROUNDS} rounds; retrying`,
  );
}

export const storageMigrationHandler: JobHandler<"storage_migration"> = {
  queue: "storage_migration",

  async run(ctx: WorkerJobContext, payload: StorageMigrationJobPayload): Promise<JobOutcome> {
    const run = tenantRunner(ctx.db, ctx.tenantId);
    const migration = await loadMigration(run, ctx.tenantId, payload.migrationId);
    if (!migration) {
      throw new Error(
        `storage migration ${payload.migrationId} does not exist for tenant ${ctx.tenantId}`,
      );
    }
    if (migration.mode !== "move") {
      // "keep" is switched synchronously by the API when the target is
      // created (nothing to copy); a job for it should never be queued, but
      // finishing quietly is safer than failing loudly on a stale retry.
      return { summary: { skipped: true, mode: migration.mode, status: migration.status } };
    }
    if (!UNFINISHED_STATUSES.includes(migration.status)) {
      return { summary: { skipped: true, status: migration.status, alreadyFinished: true } };
    }

    const tenantTargets = await loadTenantTargets(run, ctx.tenantId);
    const sourceRow = migration.sourceTargetId
      ? (tenantTargets.find((row) => row.id === migration.sourceTargetId) ?? null)
      : null;
    const destinationRow =
      tenantTargets.find((row) => row.id === migration.destinationTargetId) ?? null;
    if (!destinationRow) {
      // The destination row is gone (deleted out from under the migration):
      // nothing can make this succeed, so fail it outright instead of
      // burning retries on a target that will never come back.
      return rejectMigration(
        run,
        ctx,
        migration,
        `storage migration ${migration.id}: destination target ${migration.destinationTargetId} is gone`,
      );
    }

    // The installation default that applies right now (saved under Installation, Default
    // storage, else the environment): the API refuses to move it while this migration runs.
    const openDefaults = async (): Promise<StorageTargets> =>
      (await processDefaultStorage().current()).targets;
    const primarySource = sourceRow
      ? (await openStorageTarget(sourceRow, ctx.secrets)).backend
      : (await openDefaults()).primary;
    const destination = (await openStorageTarget(destinationRow, ctx.secrets)).backend;
    // A tenant that chose "keep" for an earlier replacement may still have
    // packs that live only on that retired target: read from it too (never
    // written to), so this migration copies them across as well (file doc
    // comment, "keep" then "move").
    const resolved = await resolveStorageTargets(tenantTargets, {
      secrets: ctx.secrets,
      defaults: openDefaults,
    });
    const source =
      resolved.previous.length > 0
        ? readOnlyFallbackChain([primarySource, ...resolved.previous])
        : primarySource;

    if (migration.status === "queued") {
      await setMigration(run, ctx.tenantId, migration.id, {
        status: "copying",
        startedAt: ctx.now(),
      });
    }

    const items = await buildItemList(run, ctx.tenantId, source);
    const loadedCursor = await ctx.cursor.load();
    const cursor = isMigrationCursor(loadedCursor) ? loadedCursor : null;

    const status = migration.status === "queued" ? "copying" : migration.status;

    let copyResult: PassOutcome | null = null;
    if (status === "copying") {
      copyResult = await runPass({
        ctx,
        run,
        migration,
        items,
        cursor,
        phase: "copying",
        source,
        destination,
        verify: "size",
        // Verifying always follows copying within this same execution.
        passesInThisRun: 2,
      });
      if (copyResult.aborted) {
        await handleAbort(run, ctx, migration);
      }
      if (copyResult.problems.length > 0 || copyResult.problemsOmitted > 0) {
        return rejectMigration(run, ctx, migration, problemSummary(copyResult, "Copying"));
      }
      await setMigration(run, ctx.tenantId, migration.id, { status: "verifying" });
      await ctx.cursor.save({ phase: "verifying", lastKey: null } satisfies MigrationCursor);
    }

    const verifyResult = await runPass({
      ctx,
      run,
      migration,
      items,
      cursor: status === "copying" ? null : cursor,
      phase: "verifying",
      source,
      destination,
      verify: "hash",
      // 2 when copying just ran in this same execution (its `done` already
      // counts toward this tracker); 1 when this execution resumed straight
      // into verifying because copying finished in an earlier attempt, so
      // this fresh tracker will only ever see this one pass.
      passesInThisRun: status === "copying" ? 2 : 1,
    });
    if (verifyResult.aborted) {
      await handleAbort(run, ctx, migration);
    }
    if (verifyResult.problems.length > 0 || verifyResult.problemsOmitted > 0) {
      return rejectMigration(run, ctx, migration, problemSummary(verifyResult, "Verifying"));
    }

    const reconciled = await reconcileBeforeSwitch(run, ctx, migration, source, destination, items);

    // Every worker process's tenant storage cache must have had time to
    // notice the destination as a copy before it is safe to retire the old
    // primary (STORAGE_CACHE_SETTLE_MS's doc comment). Not a failure: end
    // this attempt without touching the migration row (reconciliation above
    // already brought it fully up to date) so pg-boss simply retries it once
    // the wait is over, the same convention `reconcileBeforeSwitch` uses when
    // it gives up on a very active tenant.
    const remainingSettleMs = msUntilStorageCacheSettled(ctx.now(), destinationRow.createdAt);
    if (remainingSettleMs > 0) {
      throw new Error(
        `storage migration ${migration.id}: waiting ${Math.ceil(remainingSettleMs / 1000)}s for worker storage caches to notice the destination before switching; retrying`,
      );
    }

    await setMigration(run, ctx.tenantId, migration.id, { status: "switching" });
    const bytesTotal = await totalBytesOf(reconciled.items, destination);
    const failure = await switchPrimary(
      run,
      ctx,
      migration,
      sourceRow,
      destinationRow.id,
      destinationRow.config,
      { objectsTotal: reconciled.items.length, bytesTotal },
    );
    if (failure) {
      return rejectMigration(
        run,
        ctx,
        migration,
        failure === "source_not_primary"
          ? "the source is no longer the tenant's primary target; another change replaced it while this migration ran"
          : "the destination's storage settings changed while this migration ran",
      );
    }
    await ctx.cursor.clear();
    const skippedPruned = copyResult
      ? copyResult.skippedPruned + verifyResult.skippedPruned
      : verifyResult.skippedPruned;
    return {
      summary: {
        status: "completed",
        objectsTotal: reconciled.items.length,
        ...(skippedPruned > 0 ? { skippedPruned } : {}),
      },
    };
  },
};
