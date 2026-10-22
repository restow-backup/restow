/**
 * Events for the bell, the notification rules and the delivery outbox
 * (docs/ARCHITECTURE.md, Reports and notifications).
 *
 * Every event the worker raises is written as an in-app notification (the
 * bell), but a routine one (a backup succeeded, a restore check finished) only
 * when the tenant's bell has it on: one row per backup would bury everything
 * else. The bell hides the other events its column has off when it is read
 * (apps/api features/reports/service.ts); the rows stay, the overdue and quota
 * passes read some of them back. In the same transaction, each enabled event
 * rule of the tenant that lists the event gets its deliveries queued in
 * `report_deliveries`, unless the rule alerted about the same subject within
 * its throttle window, and only for the channels whose column in the
 * notification matrix has the event on (plannedDeliveries). The API's
 * dispatcher renders and sends them; nothing here talks to a mail server, so a
 * slow SMTP server never holds up a job.
 *
 * A rule with its own deadline for `backup.overdue` (`overdueAfterHours`) is left out when that
 * event is raised at the schedules' bound: the overdue pass queues its alerts by its own deadline
 * (overdue.ts, `queueRuleDeliveries`).
 */
import {
  bellEventsOf,
  type ChannelColumns,
  FAILED_JOB_EVENTS,
  guidanceFor,
  isAlertThrottled,
  isReportEvent,
  overdueDeadlineOf,
  plannedDeliveries,
  type ReportEvent,
  ROUTINE_REPORT_EVENTS,
  rulesForEvent,
  subjectKeyOf,
} from "@restow/core";
import {
  type Job,
  type NewNotification,
  type NewReportDelivery,
  notifications,
  protectedObjects,
  type ReportRule,
  reportDeliveries,
  reportRules,
  tenantNotificationRecipients,
  tenants,
  webhooks,
} from "@restow/db";
import { and, eq, max } from "drizzle-orm";
import type { TenantTx } from "./progress.js";

/** Write the notifications and queue the deliveries of every rule they reach. */
export async function raiseEvents(
  tx: TenantTx,
  raised: readonly NewNotification[],
  now: Date = new Date(),
): Promise<void> {
  if (raised.length === 0) {
    return;
  }
  const written = await forTheBell(tx, raised);
  if (written.length > 0) {
    await tx.insert(notifications).values(written);
  }

  const byTenant = new Map<string, NewNotification[]>();
  for (const notification of raised) {
    if (!notification.tenantId || !isReportEvent(notification.event)) {
      continue;
    }
    const list = byTenant.get(notification.tenantId) ?? [];
    list.push(notification);
    byTenant.set(notification.tenantId, list);
  }

  for (const [tenantId, events] of byTenant) {
    const rules = await tx
      .select()
      .from(reportRules)
      .where(
        and(
          eq(reportRules.tenantId, tenantId),
          eq(reportRules.enabled, true),
          eq(reportRules.trigger, "event"),
        ),
      );
    if (rules.length === 0) {
      continue;
    }
    const columns = await channelColumns(tx, tenantId);
    const rows: NewReportDelivery[] = [];
    for (const notification of events) {
      const event = notification.event as ReportEvent;
      for (const rule of rulesForEvent(rules, event)) {
        if (event === "backup.overdue" && overdueDeadlineOf(rule) !== null) {
          // This rule decides by its own deadline (overdue.ts).
          continue;
        }
        rows.push(...(await ruleDeliveries(tx, tenantId, rule, notification, now, columns)));
      }
    }
    if (rows.length > 0) {
      await tx.insert(reportDeliveries).values(rows);
    }
  }
}

/** The raised notifications the bell keeps: all but the routine ones its column has off. */
async function forTheBell(
  tx: TenantTx,
  raised: readonly NewNotification[],
): Promise<NewNotification[]> {
  const bells = new Map<string, readonly string[]>();
  const written: NewNotification[] = [];
  for (const notification of raised) {
    const tenantId = notification.tenantId;
    if (!tenantId || !(ROUTINE_REPORT_EVENTS as readonly string[]).includes(notification.event)) {
      written.push(notification);
      continue;
    }
    let bell = bells.get(tenantId);
    if (!bell) {
      const [tenant] = await tx
        .select({ bellEvents: tenants.bellEvents })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      bell = bellEventsOf(tenant?.bellEvents);
      bells.set(tenantId, bell);
    }
    if (bell.includes(notification.event)) {
      written.push(notification);
    }
  }
  return written;
}

/**
 * The tenant's channels and their columns in the notification matrix: what each webhook and each
 * notification recipient gets (plannedDeliveries leaves the others out).
 */
export async function channelColumns(tx: TenantTx, tenantId: string): Promise<ChannelColumns> {
  const hooks = await tx
    .select({ id: webhooks.id, events: webhooks.events })
    .from(webhooks)
    .where(eq(webhooks.tenantId, tenantId));
  const recipients = await tx
    .select({
      email: tenantNotificationRecipients.email,
      events: tenantNotificationRecipients.events,
    })
    .from(tenantNotificationRecipients)
    .where(eq(tenantNotificationRecipients.tenantId, tenantId));
  return {
    webhooks: new Map(hooks.map((hook) => [hook.id, hook.events])),
    recipients: new Map(
      recipients.map((recipient) => [recipient.email.trim().toLowerCase(), recipient.events]),
    ),
  };
}

/** When the rule last alerted about the subject; null when it never did. */
export async function lastAlertAt(
  tx: TenantTx,
  tenantId: string,
  ruleId: string,
  subjectKey: string,
): Promise<Date | null> {
  const [last] = await tx
    .select({ at: max(reportDeliveries.createdAt) })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.tenantId, tenantId),
        eq(reportDeliveries.ruleId, ruleId),
        eq(reportDeliveries.subjectKey, subjectKey),
        eq(reportDeliveries.kind, "event"),
      ),
    );
  return last?.at ?? null;
}

/**
 * The outbox rows one event gives one rule: one per channel and recipient whose column has the
 * event on, none while the rule alerted about the same subject within its throttle window. A rule
 * none of whose channels wants the event queues nothing, and so does not start a throttle window.
 */
async function ruleDeliveries(
  tx: TenantTx,
  tenantId: string,
  rule: ReportRule,
  notification: NewNotification,
  now: Date,
  columns: ChannelColumns,
): Promise<NewReportDelivery[]> {
  const event = notification.event as ReportEvent;
  const details = notification.details ?? {};
  const subjectKey = subjectKeyOf(event, details);
  const planned = plannedDeliveries(rule, "event", { event, columns });
  if (planned.length === 0) {
    return [];
  }
  if (
    isAlertThrottled(
      await lastAlertAt(tx, tenantId, rule.id, subjectKey),
      now,
      rule.throttleMinutes,
    )
  ) {
    return [];
  }
  const payload = {
    event,
    level: notification.level ?? "info",
    message: notification.message,
    details,
    occurredAt: now.toISOString(),
  };
  return planned.map((planned) => ({
    tenantId,
    ruleId: rule.id,
    ruleName: rule.name,
    kind: "event" as const,
    event,
    subjectKey,
    payload,
    channel: planned.channel,
    recipient: planned.recipient,
    language: rule.language,
    status: "pending" as const,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  }));
}

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
  const rows: NewReportDelivery[] = [];
  const columns = raised.length > 0 ? await channelColumns(tx, tenantId) : null;
  for (const notification of raised) {
    if (columns) {
      rows.push(...(await ruleDeliveries(tx, tenantId, rule, notification, now, columns)));
    }
  }
  if (rows.length > 0) {
    await tx.insert(reportDeliveries).values(rows);
  }
  return rows.length;
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
  Partial<Pick<Job, "failure">>;

/**
 * The event a finished job raises, if any: a failed backup, restore, archive
 * sync or directory sync, a completed restore, and a successful backup (a
 * routine event: the bell writes it only when its column has it on).
 * `objectName` is the protected object's display name (or null for
 * tenant-wide jobs).
 */
export function jobFinishedNotification(
  tenantId: string,
  job: FinishedJob,
  objectName: string | null,
): NewNotification | null {
  let event: ReportEvent | undefined;
  if (job.status === "failed") {
    event = FAILED_JOB_EVENTS[job.queue];
  } else if (job.status === "completed" && job.queue === "restore") {
    event = "restore.completed";
  } else if (job.status === "completed" && job.queue === "backup") {
    event = "backup.succeeded";
  }
  if (!event) {
    return null;
  }
  const target = objectName ?? job.queue;
  const failed = job.status === "failed";
  return {
    tenantId,
    level: failed ? (event === "directory.failed" ? "warning" : "error") : "info",
    event,
    message: failed
      ? `The ${job.queue} job for ${target} failed${job.errorMessage ? `: ${job.errorMessage}` : "."}`
      : `The ${job.queue} for ${target} completed.`,
    details: {
      jobId: job.id,
      queue: job.queue,
      protectedObjectId: job.protectedObjectId,
      objectName,
      errorMessage: failed ? job.errorMessage : null,
      // Why it failed and what to do, as codes the mail and the webhook consumer translate.
      failure: failed && job.failure ? alertFailure(job.failure) : null,
      completedAt: job.completedAt?.toISOString() ?? null,
    },
  };
}

/** Raise the event of a finished job inside the tenant's transaction. */
export async function raiseJobFinished(tx: TenantTx, tenantId: string, job: FinishedJob) {
  let objectName: string | null = null;
  if (job.protectedObjectId) {
    const [object] = await tx
      .select({
        displayName: protectedObjects.displayName,
        externalId: protectedObjects.externalId,
      })
      .from(protectedObjects)
      .where(
        and(
          eq(protectedObjects.tenantId, tenantId),
          eq(protectedObjects.id, job.protectedObjectId),
        ),
      );
    objectName = object ? object.displayName?.trim() || object.externalId : null;
  }
  const notification = jobFinishedNotification(tenantId, job, objectName);
  if (notification) {
    await raiseEvents(tx, [notification]);
  }
}
