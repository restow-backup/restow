/**
 * Events for the bell, the notification rules and the delivery outbox
 * (docs/ARCHITECTURE.md, Reports and notifications).
 *
 * The raise path itself lives in @restow/db (report-events.ts, `raiseReportEvents`), shared with
 * the API, which raises failed deliveries the same way: every event the worker raises is written
 * as an in-app notification (the bell), but a routine one only when the tenant's bell has it on;
 * each tenant catalog event gets a `report_events` row the API fans out to the provider's
 * recipients; and each enabled event rule of the tenant that lists the event gets its deliveries
 * queued in `report_deliveries` (at once, or held for a recipient's digest). The API's dispatcher
 * renders and sends them; nothing here talks to a mail server, so a slow SMTP server never holds
 * up a job.
 */
import {
  FAILED_JOB_EVENTS,
  guidanceFor,
  isNotBackedUpFailure,
  isServiceLimitedFailure,
  type ReportEvent,
  resolveInstallationTimeZone,
} from "@restow/core";
import {
  channelColumnsOf,
  type Database,
  type Job,
  lastRuleAlertAt,
  type NewNotification,
  protectedObjects,
  queueRuleDeliveries as queueDeliveries,
  type ReportRule,
  raiseReportEvents,
  settings,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import type { TenantTx } from "./progress.js";
import {
  loadRestoreCounts,
  nothingRestoredMessage,
  type RestoreCounts,
  restoreOutcome,
} from "./restore-outcome.js";
import { serviceLabel } from "./service-label.js";

/**
 * Where the installation's time zone comes from: `settings.time_zone`, which only the
 * installation pool may read (the jobs raise their events in a tenant transaction). Set once at
 * start-up (index.ts); unset (tests, tools) the environment's zone applies.
 */
let zoneSource: (() => Promise<string>) | null = null;
let zoneCache: { at: number; zone: string } | null = null;
const ZONE_CACHE_MS = 60_000;

export function configureReportTimeZone(deps: { providerDb: Database } | null): void {
  zoneCache = null;
  zoneSource = deps
    ? async () => {
        const [row] = await deps.providerDb
          .select({ timeZone: settings.timeZone })
          .from(settings)
          .limit(1);
        return resolveInstallationTimeZone(row?.timeZone ?? null, process.env).timeZone;
      }
    : null;
}

/**
 * The installation's time zone for the daily digest of a tenant without a zone of its own, as
 * the API reads it (the setup wizard's or Installation › Server's choice, else the environment).
 * Cached for a minute; a failed read falls back to the environment's zone.
 */
export async function reportInstallationTimeZone(): Promise<string | null> {
  if (!zoneSource) {
    return null;
  }
  const now = Date.now();
  if (zoneCache && now - zoneCache.at < ZONE_CACHE_MS) {
    return zoneCache.zone;
  }
  try {
    const zone = await zoneSource();
    zoneCache = { at: now, zone };
    return zone;
  } catch {
    return null;
  }
}

/** Write the notifications and queue the deliveries of every rule they reach. */
export async function raiseEvents(
  tx: TenantTx,
  raised: readonly NewNotification[],
  now: Date = new Date(),
): Promise<void> {
  await raiseReportEvents(tx, raised, now, { installationTimeZone: reportInstallationTimeZone });
}

/** The tenant's channels and their columns in the notification matrix. */
export const channelColumns = (tx: TenantTx, tenantId: string) => channelColumnsOf(tx, tenantId);

/** When the rule last alerted about the subject; null when it never did. */
export const lastAlertAt = (tx: TenantTx, tenantId: string, ruleId: string, subjectKey: string) =>
  lastRuleAlertAt(tx, tenantId, ruleId, subjectKey);

/**
 * Queue one rule's deliveries of events the bell already knows about, or never will: the
 * overdue pass uses it for the rules with their own `backup.overdue` deadline. Returns how many
 * rows were queued.
 */
export async function queueRuleDeliveries(
  tx: TenantTx,
  tenantId: string,
  rule: ReportRule,
  raised: readonly NewNotification[],
  now: Date,
): Promise<number> {
  return queueDeliveries(tx, tenantId, rule, raised, now, {
    installationTimeZone: reportInstallationTimeZone,
  });
}

/** The cause of a failed job as an alert carries it: code, facts and the ids of the steps to take. */
export function alertFailure(failure: NonNullable<Job["failure"]>) {
  return {
    code: failure.code,
    transient: failure.transient,
    params: failure.params,
    steps: guidanceFor({
      code: failure.code as never,
      params: failure.params,
      transient: failure.transient,
    }).steps.map((step) => step.id),
  };
}

type FinishedJob = Pick<
  Job,
  "id" | "queue" | "status" | "protectedObjectId" | "completedAt" | "errorMessage"
> &
  Partial<Pick<Job, "failure">> & {
    /** A completed restore's stored counters (restore-outcome.ts); loaded when left out. */
    readonly restoreResult?: RestoreCounts | null;
  };

/**
 * The event a finished job raises, if any: a failed backup, restore, archive
 * sync or directory sync, a completed restore, and a successful backup (a
 * routine event: the bell writes it only when its column has it on).
 * `objectName` is the protected object's display name (or null for
 * tenant-wide jobs). A restore that completed but restored nothing while items
 * failed raises restore.failed like a failed one, with the count as its error;
 * one that skipped everything stays restore.completed, saying so instead of
 * claiming it restored something (restore-outcome.ts).
 */
export function jobFinishedNotification(
  tenantId: string,
  job: FinishedJob,
  objectName: string | null,
  objectKind: string | null = null,
): NewNotification | null {
  let event: ReportEvent | undefined;
  if (
    job.status === "failed" &&
    job.queue === "backup" &&
    (isServiceLimitedFailure(job.status, job.failure) ||
      isNotBackedUpFailure(job.status, job.failure))
  ) {
    // Held back by Graph or the storage (throttled, unavailable): no failure of the object; the
    // next run tries again, and the overdue rules speak up if none gets through (core limits.ts).
    // Not backed up because the account is disabled or unlicensed: nothing to fix in Restow,
    // the mailbox resumes by itself once Microsoft hosts it again (core limits.ts).
    return null;
  }
  const outcome =
    job.status === "completed" && job.queue === "restore"
      ? restoreOutcome(job.restoreResult)
      : null;
  if (job.status === "failed" || outcome === "nothingRestored") {
    event = FAILED_JOB_EVENTS[job.queue];
  } else if (outcome) {
    event = "restore.completed";
  } else if (job.status === "completed" && job.queue === "backup") {
    event = "backup.succeeded";
  }
  if (!event) {
    return null;
  }
  // The service named with the object (0.5.0): a person's mailbox and OneDrive share a name.
  const target = objectName ? serviceLabel(objectKind, objectName) : job.queue;
  const failed = job.status === "failed" || outcome === "nothingRestored";
  // The run itself went through: its error is that not one item could be written.
  const errorMessage =
    outcome === "nothingRestored"
      ? nothingRestoredMessage(job.restoreResult?.failures ?? 0)
      : failed
        ? job.errorMessage
        : null;
  return {
    tenantId,
    level: failed ? (event === "directory.failed" ? "warning" : "error") : "info",
    event,
    message: failed
      ? `The ${job.queue} job for ${target} failed${errorMessage ? `: ${errorMessage}` : "."}`
      : outcome === "allSkipped"
        ? `The ${job.queue} for ${target} completed without restoring anything: every item was skipped.`
        : `The ${job.queue} for ${target} completed.`,
    details: {
      jobId: job.id,
      queue: job.queue,
      protectedObjectId: job.protectedObjectId,
      objectName,
      ...(objectKind ? { objectKind } : {}),
      errorMessage,
      // Set only for a restore that did not restore anything (restore-outcome.ts).
      ...(outcome === "nothingRestored" || outcome === "allSkipped"
        ? { restoreOutcome: outcome, restoreResult: job.restoreResult ?? null }
        : {}),
      // Why it failed and what to do, as codes the mail and the webhook consumer translate.
      failure: failed && job.failure ? alertFailure(job.failure) : null,
      completedAt: job.completedAt?.toISOString() ?? null,
    },
  };
}

/** Raise the event of a finished job inside the tenant's transaction. */
export async function raiseJobFinished(tx: TenantTx, tenantId: string, finished: FinishedJob) {
  const job =
    finished.restoreResult === undefined
      ? { ...finished, restoreResult: await loadRestoreCounts(tx, finished) }
      : finished;
  let objectName: string | null = null;
  let objectKind: string | null = null;
  if (job.protectedObjectId) {
    const [object] = await tx
      .select({
        displayName: protectedObjects.displayName,
        externalId: protectedObjects.externalId,
        kind: protectedObjects.kind,
      })
      .from(protectedObjects)
      .where(
        and(
          eq(protectedObjects.tenantId, tenantId),
          eq(protectedObjects.id, job.protectedObjectId),
        ),
      );
    objectName = object ? object.displayName?.trim() || object.externalId : null;
    objectKind = object?.kind ?? null;
  }
  const notification = jobFinishedNotification(tenantId, job, objectName, objectKind);
  if (notification) {
    await raiseEvents(tx, [notification]);
  }
}
