/**
 * Progress persistence: `job_progress` (one row per job, streamed to the UI by
 * the API over SSE) and `item_failures` (one row per item a job could not
 * process, with the attempt count carried over from earlier runs so the third
 * consecutive failure can raise an alert, docs/ARCHITECTURE.md).
 *
 * A run that fails thousands of items (a mailbox Microsoft throttles for an
 * hour, a share full of locked files) must not write thousands of rows: the
 * first {@link MAX_ITEM_FAILURE_ROWS} of a run are kept with their reason, cause
 * and item date, and every failure is counted per cause in
 * `jobs.item_failure_summary`, so the explanation stays exact while the table
 * stays bounded (docs/MICROSOFT.md, "Warnings and failed items").
 *
 * The batching lives in @restow/core's ProgressTracker; this sink is what it
 * publishes to. Each publish is one tenant-pinned transaction. It also doubles
 * as the cancellation probe: if the API flipped the job to `cancelled` while it
 * runs, the sink reports that back so the runner can abort the engine.
 */
import {
  type ItemFailureRecord,
  type Logger,
  type ProgressSink,
  ProgressTracker,
  type ProgressUpdate,
  UNKNOWN_WARNING_CAUSE,
} from "@restow/core";
import {
  type Database,
  type ItemFailureSummaryJson,
  itemFailures,
  jobProgress,
  jobs,
  recordRunSample,
  reportableError,
  samplePoint,
  withoutQueryText,
} from "@restow/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { itemFailureRecord } from "./failure.js";

/** Runs `fn` inside a transaction pinned to one tenant (RLS). Provided by the framework. */
export type TenantTxRunner = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
export type TenantTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** After this many consecutive runs an item's failure is escalated. */
export const REPEATED_FAILURE_THRESHOLD = 3;

/** The failed items of one run kept as rows; the rest are counted in `jobs.item_failure_summary`. */
export const MAX_ITEM_FAILURE_ROWS = 200;

/** The longest cause code counted in a summary; anything longer is a malformed record. */
const MAX_CAUSE_KEY = 80;
/** The most distinct causes a summary keeps; the rest are counted under "unknown". */
const MAX_SUMMARY_CAUSES = 50;

/** A summary read back from the jobs row, defensively. */
export function parseItemFailureSummary(value: unknown): ItemFailureSummaryJson {
  const empty: ItemFailureSummaryJson = { total: 0, stored: 0, byCause: {} };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return empty;
  }
  const raw = value as Record<string, unknown>;
  const count = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) && entry > 0 ? Math.floor(entry) : 0;
  const byCause: Record<string, number> = {};
  if (raw.byCause && typeof raw.byCause === "object" && !Array.isArray(raw.byCause)) {
    for (const [code, entry] of Object.entries(raw.byCause as Record<string, unknown>)) {
      if (code.length > 0 && code.length <= MAX_CAUSE_KEY && count(entry) > 0) {
        byCause[code] = count(entry);
      }
    }
  }
  return { total: count(raw.total), stored: count(raw.stored), byCause };
}

/**
 * Add a batch of failures to a run's summary: every failure is counted under its cause, and
 * `stored` grows by the rows actually written.
 */
export function addToSummary(
  summary: ItemFailureSummaryJson,
  failures: readonly Pick<ItemFailureRecord, "cause">[],
  stored: number,
): ItemFailureSummaryJson {
  const byCause = { ...summary.byCause };
  for (const failure of failures) {
    let code = failure.cause?.code ?? UNKNOWN_WARNING_CAUSE;
    if (code.length > MAX_CAUSE_KEY) {
      code = UNKNOWN_WARNING_CAUSE;
    }
    if (!(code in byCause) && Object.keys(byCause).length >= MAX_SUMMARY_CAUSES) {
      code = UNKNOWN_WARNING_CAUSE;
    }
    byCause[code] = (byCause[code] ?? 0) + 1;
  }
  return {
    total: summary.total + failures.length,
    stored: summary.stored + stored,
    byCause,
  };
}

export interface PgProgressSinkOptions {
  readonly run: TenantTxRunner;
  readonly tenantId: string;
  readonly jobId: string;
  readonly protectedObjectId: string | null;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** Invoked when the jobs row turned `cancelled` while the job is running. */
  readonly onCancelRequested?: () => void;
}

/** Highest previous attempt count per item ref, looked up in one query. */
async function previousAttempts(
  tx: TenantTx,
  tenantId: string,
  protectedObjectId: string | null,
  itemRefs: readonly string[],
): Promise<Map<string, number>> {
  const attempts = new Map<string, number>();
  if (!protectedObjectId || itemRefs.length === 0) {
    return attempts;
  }
  const rows = await tx
    .select({ itemRef: itemFailures.itemRef, attempts: itemFailures.attempts })
    .from(itemFailures)
    .where(
      and(
        eq(itemFailures.tenantId, tenantId),
        eq(itemFailures.protectedObjectId, protectedObjectId),
        inArray(itemFailures.itemRef, [...new Set(itemRefs)]),
      ),
    )
    .orderBy(desc(itemFailures.createdAt));
  for (const row of rows) {
    attempts.set(row.itemRef, Math.max(attempts.get(row.itemRef) ?? 0, row.attempts));
  }
  return attempts;
}

export class PgProgressSink implements ProgressSink {
  private readonly now: () => Date;
  private cancelReported = false;

  constructor(private readonly options: PgProgressSinkOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Create the progress row up front so the UI sees the job as soon as it starts. */
  async ensureRow(): Promise<void> {
    const { tenantId, jobId } = this.options;
    await this.options.run(async (tx) => {
      await tx
        .insert(jobProgress)
        .values({ tenantId, jobId })
        .onConflictDoNothing({ target: jobProgress.jobId });
    });
  }

  async publish(update: ProgressUpdate): Promise<void> {
    const { tenantId, jobId } = this.options;
    const { snapshot, failures } = update;
    const now = this.now();
    // An engine that does not count what it read has read what it stored.
    const bytesProcessed = Math.max(snapshot.bytesProcessed ?? 0, snapshot.bytes);
    const bytesTransferred = snapshot.bytesTransferred ?? 0;

    const status = await this.options.run(async (tx) => {
      await tx
        .insert(jobProgress)
        .values({
          tenantId,
          jobId,
          total: snapshot.total,
          done: snapshot.done,
          failed: snapshot.failed,
          bytes: snapshot.bytes,
          bytesProcessed,
          bytesTransferred,
          etaSeconds: snapshot.etaSeconds,
        })
        .onConflictDoUpdate({
          target: jobProgress.jobId,
          set: {
            total: snapshot.total,
            done: snapshot.done,
            failed: snapshot.failed,
            bytes: snapshot.bytes,
            bytesProcessed,
            bytesTransferred,
            etaSeconds: snapshot.etaSeconds,
            updatedAt: now,
          },
        });
      // The throughput history of the run: one measurement per publish (the run drawer's charts).
      await recordRunSample(
        tx,
        { tenantId, jobId },
        samplePoint(now.getTime(), bytesProcessed, bytesTransferred),
        { now },
      );

      if (failures.length > 0) {
        await this.insertFailures(tx, failures, now, snapshot.phase);
      }

      const [row] = await tx
        .select({ status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);
      return row?.status ?? null;
    });

    if (status === "cancelled" && !this.cancelReported) {
      this.cancelReported = true;
      this.options.onCancelRequested?.();
    }
  }

  private async insertFailures(
    tx: TenantTx,
    failures: readonly ItemFailureRecord[],
    now: Date,
    phase: string | null,
  ): Promise<void> {
    const { tenantId, jobId, protectedObjectId, logger } = this.options;
    // The summary lives on the jobs row, so a retried attempt continues the count of the run.
    const [job] = await tx
      .select({ summary: jobs.itemFailureSummary })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
      .limit(1);
    const summary = parseItemFailureSummary(job?.summary ?? null);
    const room = Math.max(0, MAX_ITEM_FAILURE_ROWS - summary.stored);
    const kept = failures.slice(0, room);
    await tx
      .update(jobs)
      .set({ itemFailureSummary: addToSummary(summary, failures, kept.length) })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)));
    if (kept.length < failures.length && summary.stored + kept.length === MAX_ITEM_FAILURE_ROWS) {
      logger.info("item failures beyond the kept rows are only counted", {
        event: "item.failure.capped",
        kept: MAX_ITEM_FAILURE_ROWS,
      });
    }
    if (kept.length === 0) {
      return;
    }
    const previous = await previousAttempts(
      tx,
      tenantId,
      protectedObjectId,
      kept.map((f) => f.itemRef),
    );
    const rows = kept.map((failure) => {
      const attempts = (previous.get(failure.itemRef) ?? 0) + 1;
      // Every engine's item failures pass through here on their way to the UI;
      // a reason built from a failed query keeps its words, not the query.
      const reason = withoutQueryText(failure.reason);
      if (attempts >= REPEATED_FAILURE_THRESHOLD) {
        logger.warn("item failed in consecutive runs", {
          event: "item.failure.repeated",
          itemRef: failure.itemRef,
          attempts,
          reason,
        });
      }
      return {
        tenantId,
        jobId,
        protectedObjectId,
        itemRef: failure.itemRef,
        reason: reason.slice(0, 2000),
        // The classified cause, when the engine had the error at hand; the reason stays either way.
        failure: failure.cause ? itemFailureRecord(failure.cause, now, phase) : null,
        itemDate: failure.itemDate ? new Date(failure.itemDate) : null,
        attempts,
        lastAttemptAt: now,
      };
    });
    await tx.insert(itemFailures).values(rows);
  }
}

export interface CreateProgressOptions extends PgProgressSinkOptions {
  readonly flushEveryItems?: number;
  readonly flushIntervalMs?: number;
}

/** A batched ProgressReporter persisting through {@link PgProgressSink}. */
export function createProgressReporter(options: CreateProgressOptions): {
  reporter: ProgressTracker;
  sink: PgProgressSink;
} {
  const sink = new PgProgressSink(options);
  const reporter = new ProgressTracker({
    sink,
    flushEveryItems: options.flushEveryItems,
    flushIntervalMs: options.flushIntervalMs,
    onError: (error) => {
      // The driver error, not the failed query with the progress it tried to write.
      options.logger.warn("progress update failed", { error: reportableError(error) });
    },
  });
  return { reporter, sink };
}
