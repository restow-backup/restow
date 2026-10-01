/**
 * The `verify` queue handler: the restore proof for one protected object
 * (docs/TESTING.md, restore proof in production).
 *
 * The scheduler enqueues it weekly per object, the backup handler after a
 * backup when the tenant schedules verification, and the API on "check now".
 * The run itself is core's `verifyProtectedObject` (packages/core/src/verify):
 * a random sample of the latest snapshot is read back through the restore
 * path and compared with the manifest; a health check reads everything.
 *
 * This handler adds what only the worker knows:
 *   - packs the latest scrub left corrupt, so an object whose data sits in a
 *     damaged pack is never rated green just because the sample missed it
 *   - an optional test-restore probe per object (registered by the
 *     integration layer once a tenant has a test target)
 * and persists the outcome: a `verify_reports` row (the rating of the checked
 * snapshot, linked by `snapshot_id`, with its date), `jobs.payload.result` for
 * the job views, and an in-app notification whenever the rating changes for
 * the worse, or recovers. Every recorded outcome is also announced as the
 * `verify.completed` webhook.
 *
 * The rating belongs to the snapshot it checked, not to the object: a backup
 * taken after a green check is not verified until a check of that snapshot
 * ran (the API's verification-state rule reads `snapshot_id` for that).
 *
 * A check that could not complete (core `VerifyIncompleteError`: the storage
 * did not answer, and nothing read so far proves damage) records no report,
 * raises no notification and no `verify.completed`, and leaves the object's
 * last check as it was. Its job notes `{ incomplete: true }` as its result and
 * fails the attempt, so pg-boss repeats it with the queue's backoff; the last
 * attempt completes the job instead of failing it, so an outage never becomes
 * a failed job, a `job.failed` webhook or a red rating. The next scheduled
 * check tries again.
 */
import {
  DEFAULT_SAMPLE_SIZE,
  type FailureCause,
  type ProtectedObjectRef,
  type RecoveryReadiness,
  type RestoreProbe,
  VerifyIncompleteError,
  type VerifyJobPayload,
  type VerifyKind,
  type VerifyOutcome,
  verifyProtectedObject,
} from "@restow/core";
import {
  type Database,
  type NewNotification,
  type NewVerifyReport,
  jobs,
  safeErrorMessage,
  verifyReports,
} from "@restow/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { QUEUE_DEFINITIONS } from "../queues.js";
import { raiseEvents } from "../reporting.js";
import {
  InvalidPayloadError,
  type JobHandler,
  type JobOutcome,
  type WorkerJobContext,
  tenantRunner,
} from "./framework.js";
import { loadCorruptPackPaths } from "./scrub.js";
import { emitWebhookEvent } from "./webhooks.js";

/** Upper bound for a requested sample size; larger checks are what health checks are for. */
export const MAX_SAMPLE_SIZE = 200;

/** The requested per-category sample size, or the default for anything unusable. */
export function normalizeSampleSize(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SAMPLE_SIZE
    ? value
    : DEFAULT_SAMPLE_SIZE;
}

export function verifyKindOf(payload: Pick<VerifyJobPayload, "kind">): VerifyKind {
  return payload.kind === "health_check" ? "health_check" : "verify";
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** In-app notification events this handler raises (the UI translates them). */
export const VERIFY_EVENTS = {
  red: "verify.red",
  yellow: "verify.yellow",
  recovered: "verify.recovered",
} as const;

function objectLabel(object: ProtectedObjectRef): string {
  return object.displayName ?? object.externalId;
}

/** The red reasons that prove a restore would fail: everything red but an old backup. */
const RED_EVIDENCE = new Set([
  "no_snapshot",
  "manifest_unreadable",
  "items_missing",
  "items_unreadable",
  "items_mismatched",
  "storage_corrupt",
  "test_restore_failed",
]);

/**
 * Why a rating is red, for the alert texts: `outdated` when the only red
 * reason is a newest backup that is too old (the data that is there is fine),
 * `damaged` when the check found data missing or damaged (or nothing to restore).
 */
export function redReasonOf(reasons: readonly string[]): "outdated" | "damaged" {
  return reasons.includes("snapshot_outdated") &&
    !reasons.some((reason) => RED_EVIDENCE.has(reason))
    ? "outdated"
    : "damaged";
}

/**
 * The notification for a rating change, or null when nothing changed for the
 * operator: a first report that is green, or the same rating as last time. A
 * red one says whether data is damaged or missing or the newest backup is
 * merely too old (`details.redReason`, which the bell and the alert mail word).
 */
export function readinessNotification(input: {
  readonly tenantId: string;
  readonly object: ProtectedObjectRef;
  readonly previous: RecoveryReadiness | null;
  readonly current: RecoveryReadiness;
  readonly reportId: string;
  readonly reasons: readonly string[];
}): NewNotification | null {
  const { previous, current, object } = input;
  if (previous === current || (previous === null && current === "green")) {
    return null;
  }
  const details = {
    protectedObjectId: object.id,
    objectName: objectLabel(object),
    objectKind: object.kind,
    reportId: input.reportId,
    readiness: current,
    previous,
    reasons: [...input.reasons],
  };
  if (current === "red") {
    const redReason = redReasonOf(input.reasons);
    return {
      tenantId: input.tenantId,
      level: "error",
      event: VERIFY_EVENTS.red,
      message:
        redReason === "outdated"
          ? `Recovery readiness of ${objectLabel(object)} is red: the newest backup is too old, newer data could not be restored.`
          : `Recovery readiness of ${objectLabel(object)} is red: a restore would not be complete.`,
      details: { ...details, redReason },
    };
  }
  if (current === "yellow") {
    if (previous === "red") {
      return null;
    }
    return {
      tenantId: input.tenantId,
      level: "warning",
      event: VERIFY_EVENTS.yellow,
      message: `Recovery readiness of ${objectLabel(object)} needs attention.`,
      details,
    };
  }
  return {
    tenantId: input.tenantId,
    level: "info",
    event: VERIFY_EVENTS.recovered,
    message: `Recovery readiness of ${objectLabel(object)} is green again.`,
    details,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** The `jobs.payload.result` of a verify job (read by the API's job views). */
export interface StoredVerifyResult {
  reportId: string;
  readiness: RecoveryReadiness;
  snapshotId: string | null;
  checked: number;
  mismatched: number;
  missing: number;
  completedAt: string;
}

export function toStoredVerifyResult(
  reportId: string,
  outcome: VerifyOutcome,
  completedAt: Date,
): StoredVerifyResult {
  return {
    reportId,
    readiness: outcome.readiness,
    snapshotId: outcome.snapshotId,
    checked: outcome.checked,
    mismatched: outcome.mismatched,
    missing: outcome.missing,
    completedAt: completedAt.toISOString(),
  };
}

/**
 * The `jobs.payload.result` of an attempt that could not complete: no rating,
 * the reason, the classified cause (always transient) and whether pg-boss
 * repeats the attempt. The API reads `incomplete` (jobs DTO `checkIncomplete`).
 */
export interface StoredIncompleteVerify {
  incomplete: true;
  reason: string;
  failure: Pick<FailureCause, "code" | "params" | "transient">;
  willRetry: boolean;
  completedAt: string;
}

export function toStoredIncompleteVerify(
  error: VerifyIncompleteError,
  willRetry: boolean,
  at: Date,
): StoredIncompleteVerify {
  return {
    incomplete: true,
    reason: error.detail.slice(0, 500),
    failure: {
      code: error.failure.code,
      params: error.failure.params,
      transient: error.failure.transient,
    },
    willRetry,
    completedAt: at.toISOString(),
  };
}

/** What one verify run records. */
export interface VerifyRecord {
  readonly tenantId: string;
  readonly jobId: string;
  readonly object: ProtectedObjectRef;
  readonly kind: VerifyKind;
  readonly outcome: VerifyOutcome;
  /** The object's rating before this run (any snapshot), for the notification. */
  readonly previous: RecoveryReadiness | null;
  readonly checkedAt: Date;
}

/**
 * The `verify_reports` row of a run. `snapshotId` names the snapshot that was
 * read back; it is null only when the object had no completed snapshot, and a
 * report without it never counts as the verification of any backup.
 */
export function verifyReportRow(record: VerifyRecord): NewVerifyReport {
  return {
    tenantId: record.tenantId,
    protectedObjectId: record.object.id,
    jobId: record.jobId,
    snapshotId: record.outcome.snapshotId,
    kind: record.kind,
    recoveryReadiness: record.outcome.readiness,
    details: record.outcome.details,
    checkedAt: record.checkedAt,
  };
}

/** The notification a recorded run raises, or null when the rating did not change. */
export function verifyRecordNotification(
  record: VerifyRecord,
  reportId: string,
): NewNotification | null {
  return readinessNotification({
    tenantId: record.tenantId,
    object: record.object,
    previous: record.previous,
    current: record.outcome.readiness,
    reportId,
    reasons: record.outcome.details.reasons.map((reason) => reason.code),
  });
}

/**
 * Where the handler reads its inputs and records the outcome. The Postgres
 * store is the production one; tests pass an in-memory store so the whole
 * handler runs on the memory engine.
 */
export interface VerifyStore {
  /** The newest rating of the object, whichever snapshot it checked; null before the first. */
  previousReadiness(protectedObjectId: string): Promise<RecoveryReadiness | null>;
  /** Storage keys of the packs the latest completed scrub left corrupt. */
  damagedPacks(): Promise<ReadonlySet<string>>;
  /**
   * Record the report, the job result and the notification for a rating
   * change, all or nothing (one transaction in Postgres).
   */
  record(record: VerifyRecord): Promise<StoredVerifyResult>;
  /** Note on the job that this attempt could not complete; nothing else is written. */
  recordIncomplete(jobId: string, result: StoredIncompleteVerify): Promise<void>;
}

/** The production store: tenant-pinned transactions on the worker database (RLS applies). */
export function pgVerifyStore(db: Database, tenantId: string): VerifyStore {
  const run = tenantRunner(db, tenantId);
  return {
    async previousReadiness(protectedObjectId) {
      const [row] = await run((tx) =>
        tx
          .select({ readiness: verifyReports.recoveryReadiness })
          .from(verifyReports)
          .where(
            and(
              eq(verifyReports.tenantId, tenantId),
              eq(verifyReports.protectedObjectId, protectedObjectId),
            ),
          )
          .orderBy(desc(verifyReports.checkedAt), desc(verifyReports.createdAt))
          .limit(1),
      );
      return row?.readiness ?? null;
    },

    damagedPacks: () => loadCorruptPackPaths(run, tenantId),

    async record(record) {
      if (record.tenantId !== tenantId) {
        throw new Error("verify record belongs to another tenant");
      }
      return run(async (tx) => {
        const [report] = await tx
          .insert(verifyReports)
          .values(verifyReportRow(record))
          .returning({ id: verifyReports.id });
        if (!report) {
          throw new Error("verify report was not recorded");
        }
        const stored = toStoredVerifyResult(report.id, record.outcome, record.checkedAt);
        await tx
          .update(jobs)
          .set({
            payload: sql`coalesce(${jobs.payload}, '{}'::jsonb) || ${JSON.stringify({ result: stored })}::jsonb`,
          })
          .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, record.jobId)));
        const notification = verifyRecordNotification(record, report.id);
        if (notification) {
          await raiseEvents(tx, [notification]);
        }
        return stored;
      });
    },

    async recordIncomplete(jobId, result) {
      await run((tx) =>
        tx
          .update(jobs)
          .set({
            payload: sql`coalesce(${jobs.payload}, '{}'::jsonb) || ${JSON.stringify({ result })}::jsonb`,
          })
          .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId))),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Supplies a test-restore probe for an object, or null when it has no test target. */
export type VerifyProbeResolver = (
  ctx: WorkerJobContext,
  protectedObject: ProtectedObjectRef,
) => Promise<RestoreProbe | null>;

/** The `data` of the `verify.completed` webhook event: what an RMM tile or ticket needs. */
export interface VerifyCompletedEvent extends StoredVerifyResult {
  jobId: string;
  kind: VerifyKind;
  protectedObjectId: string;
  objectKind: ProtectedObjectRef["kind"];
  objectName: string;
  previous: RecoveryReadiness | null;
  reasons: string[];
}

export interface VerifyHandlerOptions {
  /** Resolved per job, so a resolver registered after start-up is picked up. */
  readonly probes: () => VerifyProbeResolver | null;
  /** Announces a recorded outcome (the `verify.completed` webhook); failures are logged only. */
  readonly announce?: (ctx: WorkerJobContext, event: VerifyCompletedEvent) => Promise<unknown>;
  /** Where inputs are read and the outcome recorded; the Postgres store by default. */
  readonly store?: (ctx: WorkerJobContext) => VerifyStore;
}

export function createVerifyHandler(options: VerifyHandlerOptions): JobHandler<"verify"> {
  const storeFor =
    options.store ?? ((ctx: WorkerJobContext) => pgVerifyStore(ctx.db, ctx.tenantId));
  return {
    queue: "verify",

    async run(ctx: WorkerJobContext, payload: VerifyJobPayload): Promise<JobOutcome> {
      const object = ctx.protectedObject;
      if (!object) {
        throw new InvalidPayloadError("verify job payload names no protected object");
      }
      const kind = verifyKindOf(payload);
      const sampleSize = normalizeSampleSize(payload.sampleSize);
      const store = storeFor(ctx);
      const [previous, damaged] = await Promise.all([
        store.previousReadiness(object.id),
        store.damagedPacks(),
      ]);
      const resolver = options.probes();
      const probe = kind === "verify" && resolver ? await resolver(ctx, object) : null;

      let outcome: VerifyOutcome;
      try {
        outcome = await verifyProtectedObject(ctx, object, {
          kind,
          sampleSize,
          damagedPacks: damaged,
          probe,
        });
      } catch (error) {
        if (!(error instanceof VerifyIncompleteError)) {
          throw error;
        }
        // No rating: the storage (or the test target) could not be asked. pg-boss repeats the
        // attempt with the queue's backoff; the last one completes the job instead of failing it.
        const willRetry = ctx.attempt < QUEUE_DEFINITIONS.verify.retryLimit;
        const result = toStoredIncompleteVerify(error, willRetry, ctx.now());
        await store.recordIncomplete(ctx.jobId, result);
        ctx.logger.warn("restore check could not complete", {
          reason: result.reason,
          cause: result.failure.code,
          attempt: ctx.attempt,
          willRetry,
        });
        if (willRetry) {
          throw error;
        }
        return { summary: { ...result, kind, previous } };
      }
      const stored = await store.record({
        tenantId: ctx.tenantId,
        jobId: ctx.jobId,
        object,
        kind,
        outcome,
        previous,
        checkedAt: ctx.now(),
      });
      const reasons = outcome.details.reasons.map((reason) => reason.code);
      if (options.announce) {
        // The report is recorded; a failed announcement must not repeat the check.
        await options
          .announce(ctx, {
            ...stored,
            jobId: ctx.jobId,
            kind,
            protectedObjectId: object.id,
            objectKind: object.kind,
            objectName: objectLabel(object),
            previous,
            reasons,
          })
          .catch((error: unknown) =>
            ctx.logger.warn("verify.completed webhook could not be queued", {
              errorMessage: safeErrorMessage(error),
            }),
          );
      }
      return { summary: { ...stored, kind, previous, reasons } };
    },
  };
}

// ---------------------------------------------------------------------------
// Default registry (filled by the integration layer)
// ---------------------------------------------------------------------------

let probeResolver: VerifyProbeResolver | null = null;

/** Register how test-restore targets are found; without one, verify reads back only. */
export function registerVerifyProbeResolver(resolver: VerifyProbeResolver | null): void {
  probeResolver = resolver;
}

/** The handler listed in ./index.ts. */
export const verifyHandler: JobHandler<"verify"> = createVerifyHandler({
  probes: () => probeResolver,
  announce: (ctx, event) =>
    emitWebhookEvent(ctx.db, {
      tenantId: ctx.tenantId,
      event: "verify.completed",
      data: { ...event },
      occurredAt: new Date(event.completedAt),
    }),
});
