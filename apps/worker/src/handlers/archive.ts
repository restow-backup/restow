/**
 * The `archive` queue (docs/ARCHIVE.md "Erfassungswege").
 *
 * Continuous capture from the mailbox is the capture service's (../archive-capture), not a
 * job per mail. This queue carries two things:
 *
 *   - `mode: "backfill"`: the one-time takeover of a mailbox's existing mail by a capture
 *     way, queued by the capture service once the stream went live (the `jobs` row shows it
 *     as the archive takeover). The way's `backfill` runs checkpointed in the job's cursor;
 *     interrupted, it resumes there. Mail received before the stream went live is flagged
 *     `captured-late`. Done, the stream is `live`.
 *   - without a mode (the archive schedules of older releases): the named mailboxes, or
 *     every mailbox of the named source, are made due for the capture service now.
 *
 * While the gate `archive.mailboxCapture` is closed (the Community build) the job ends
 * at once as skipped, with the reason in its summary.
 */
import { type ArchiveJobPayload, JobAbortedError } from "@restow/core";
import type { Database } from "@restow/db";
import { sql } from "drizzle-orm";
import { alreadyCapturedFor, appendCapturedMail } from "../archive-capture/append.js";
import { CAPTURE_WAYS } from "../archive-capture/registry.js";
import { type BackfillEnqueuer, pgBackfillEnqueuer } from "../archive-capture/service.js";
import { PgStreamStore } from "../archive-capture/streams.js";
import type { BackfillContext, CaptureWay, MailboxWay } from "../archive-capture/ways.js";
import type { WorkerFeatureGate } from "../extensions.js";
import type { JobHandler, JobOutcome, WorkerJobContext } from "./framework.js";
import { archiveRetentionPolicyFor } from "./import-archive.js";

export interface ArchiveHandlerDeps {
  /** The installation pool (streams across the tenant's sources). */
  readonly providerDb: Database;
  readonly gate: WorkerFeatureGate;
  readonly ways?: Partial<Record<MailboxWay, CaptureWay>>;
  readonly enqueueBackfill?: BackfillEnqueuer;
}

let configured: ArchiveHandlerDeps | null = null;

/** Set at worker start (./index.ts); without it every archive job is skipped. */
export function configureArchiveHandler(deps: ArchiveHandlerDeps | null): void {
  configured = deps;
}

/** Parallel backfills per worker process (`ARCHIVE_BACKFILL_CONCURRENCY`, default 4). */
export function backfillConcurrency(env: Record<string, string | undefined> = process.env): number {
  const value = Number.parseInt(env.ARCHIVE_BACKFILL_CONCURRENCY?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 4;
}

function skipped(reason: string): JobOutcome {
  return { summary: { status: "skipped", reason } };
}

/** Make the payload's mailboxes due for the capture service. */
async function markDue(
  deps: ArchiveHandlerDeps,
  ctx: WorkerJobContext,
  payload: ArchiveJobPayload,
): Promise<JobOutcome> {
  const target = payload.protectedObjectId
    ? sql`protected_object_id = ${payload.protectedObjectId}::uuid`
    : payload.sourceId
      ? sql`source_id = ${payload.sourceId}::uuid`
      : sql`true`;
  const result = await deps.providerDb.execute(sql`
    update archive_capture_streams
       set next_due_at = now(), dirty_since = coalesce(dirty_since, now()), updated_at = now()
     where tenant_id = ${ctx.tenantId}::uuid and way = ${payload.capture}
       and status not in ('paused', 'disabled') and ${target}
  `);
  return { summary: { status: "marked_due", streams: result.rowCount ?? 0 } };
}

async function backfill(
  deps: ArchiveHandlerDeps,
  ctx: WorkerJobContext,
  payload: ArchiveJobPayload,
): Promise<JobOutcome> {
  if (!payload.protectedObjectId) {
    return skipped("a backfill names no mailbox");
  }
  const way = (deps.ways ?? CAPTURE_WAYS)[payload.capture];
  if (!way) {
    return skipped(`the capture way ${payload.capture} is not part of this build`);
  }
  const store = new PgStreamStore(deps.providerDb);
  const stream = await store.find(payload.protectedObjectId, payload.capture);
  if (!stream || stream.tenantId !== ctx.tenantId) {
    return skipped("the mailbox has no capture stream");
  }
  if (stream.status === "disabled" || stream.status === "paused") {
    return skipped(`the capture stream is ${stream.status}`);
  }
  if (stream.backfillCompletedAt !== null) {
    return { summary: { status: "completed", alreadyDone: true } };
  }
  const retentionPolicy = await archiveRetentionPolicyFor(ctx.db, ctx.tenantId);
  const logger = ctx.logger.child({ streamId: stream.id, way: stream.way });
  const backfillContext: BackfillContext = {
    db: ctx.db,
    tenantId: ctx.tenantId,
    stream,
    reason: "scheduled",
    keys: ctx.keys,
    storage: ctx.storage,
    logger,
    signal: ctx.signal,
    now: ctx.now,
    job: ctx,
    append: (mail) =>
      appendCapturedMail(
        {
          db: ctx.db,
          tenantId: ctx.tenantId,
          storage: ctx.storage,
          keys: ctx.keys,
          index: ctx.chunkIndex,
          retentionPolicy,
          logger,
          now: ctx.now,
          signal: ctx.signal,
        },
        stream,
        mail,
      ),
    alreadyCaptured: (query) =>
      alreadyCapturedFor(ctx.db, ctx.tenantId, stream.protectedObjectId, query),
    // The backfill's own position lives in the job's cursor; the stream's state belongs to
    // the live passes and is not written from here.
    checkpoint: async () => undefined,
  };
  const result = await way.backfill(backfillContext);
  if (ctx.signal.aborted) {
    throw new JobAbortedError();
  }
  if (!result.completed) {
    // The way stopped on its own budget: the next job resumes from the cursor.
    const next = await (deps.enqueueBackfill ?? pgBackfillEnqueuer(ctx.db))(stream);
    return {
      summary: { status: "continued", captured: result.captured, skipped: result.skipped, next },
    };
  }
  await store.backfillCompleted(stream.id);
  await ctx.cursor.clear();
  logger.info("archive backfill completed", { captured: result.captured, skipped: result.skipped });
  return { summary: { status: "completed", captured: result.captured, skipped: result.skipped } };
}

export const archiveHandler: JobHandler<"archive"> = {
  queue: "archive",
  concurrency: backfillConcurrency(),
  async run(ctx, payload) {
    const deps = configured;
    if (!deps || !(await deps.gate.isEnabled("archive.mailboxCapture"))) {
      return skipped("archive capture from the mailbox is not enabled (archive.mailboxCapture)");
    }
    return payload.mode === "backfill" ? backfill(deps, ctx, payload) : markDue(deps, ctx, payload);
  },
};
