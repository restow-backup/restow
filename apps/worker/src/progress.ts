/**
 * Progress persistence: `job_progress` (one row per job, streamed to the UI by
 * the API over SSE) and `item_failures` (one row per item a job could not
 * process, with the attempt count carried over from earlier runs so the third
 * consecutive failure can raise an alert, docs/ARCHITECTURE.md).
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
} from "@restow/core";
import {
  type Database,
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
    const previous = await previousAttempts(
      tx,
      tenantId,
      protectedObjectId,
      failures.map((f) => f.itemRef),
    );
    const rows = failures.map((failure) => {
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
