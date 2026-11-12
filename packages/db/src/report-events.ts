/**
 * Raising events for the bell, the notification rules and the provider's recipients
 * (docs/ARCHITECTURE.md, "Berichte und Benachrichtigungen"; docs/NOTIFICATIONS.md). The worker
 * raises job and check events with it, the API the failed deliveries; both run inside a
 * transaction pinned to the tenant, so nothing here crosses tenants.
 *
 * For each raised event, in the caller's transaction:
 *
 * 1. The bell row. Every event is written, but a routine one (a backup succeeded, a restore check
 *    finished) only when the tenant's bell has it on; the critical events and failed deliveries
 *    are always on (bellEventsOf).
 * 2. A `report_events` row for each tenant catalog event: the API's dispatcher fans it out to the
 *    provider's recipients (apps/api features/reports/fanout.ts), which a tenant session can never
 *    read.
 * 3. The deliveries of every enabled event rule of the tenant that lists the event, unless the
 *    rule alerted about the same subject within its throttle window, and only to the channels
 *    whose column in the notification matrix has the event on (plannedDeliveries). An e-mail
 *    recipient that collects the event's severity in a digest gets a row held until the digest is
 *    due (`digest`, `next_attempt_at`). A failed delivery's alert leaves out the channel that
 *    failed (deliveryFailureExclusion).
 *
 * A rule with its own deadline for `backup.overdue` (`overdueAfterHours`) is left out when that
 * event is raised at the schedules' bound: the worker's overdue pass queues its alerts by its own
 * deadline (`queueRuleDeliveries`).
 */
import {
  bellEventsOf,
  type ChannelColumns,
  type DeliveryModes,
  deliveryFailureExclusion,
  digestDueAt,
  environmentTimeZone,
  isAlertThrottled,
  isFloorReportEvent,
  isReportEvent,
  overdueDeadlineOf,
  plannedDeliveries,
  type ReportEvent,
  type ReportEventLevel,
  ROUTINE_REPORT_EVENTS,
  rulesForEvent,
  subjectKeyOf,
} from "@restow/core";
import { and, eq, max } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type NewNotification, notifications } from "./schema/notifications.js";
import {
  type NewReportDelivery,
  type ReportRule,
  reportDeliveries,
  reportEvents,
  reportRules,
} from "./schema/reports.js";
import { tenantNotificationRecipients, tenants } from "./schema/tenants.js";
import { webhooks } from "./schema/webhooks.js";

// biome-ignore lint/suspicious/noExplicitAny: any schema, a transaction or the pool itself
type ReportTx = Pick<NodePgDatabase<any>, "select" | "insert" | "update" | "execute">;

/**
 * The installation's time zone (`settings.time_zone` as resolveInstallationTimeZone reads it), or
 * how to load it: the tenant role cannot read `settings`, so the caller, which holds the
 * installation pool, supplies it. A loader is only called when a tenant without a zone of its
 * own needs it.
 */
export type InstallationZoneInput =
  | string
  | null
  | undefined
  | (() => Promise<string | null | undefined>);

export interface RaiseReportEventsOptions {
  /**
   * The installation's time zone, for the daily digest of a tenant without a zone of its own.
   * Without it the environment's zone (or Europe/Berlin) is used: every caller that can should
   * pass it, so a digest's hour does not depend on which process raised the event.
   */
  readonly installationTimeZone?: InstallationZoneInput;
}

/**
 * The tenant's channels and their columns in the notification matrix: what each webhook and each
 * notification recipient gets, and how each recipient wants it (at once or in a digest).
 */
export async function channelColumnsOf(tx: ReportTx, tenantId: string): Promise<ChannelColumns> {
  const hooks = await tx
    .select({ id: webhooks.id, events: webhooks.events })
    .from(webhooks)
    .where(eq(webhooks.tenantId, tenantId));
  const recipients = await tx
    .select({
      email: tenantNotificationRecipients.email,
      events: tenantNotificationRecipients.events,
      delivery: tenantNotificationRecipients.delivery,
    })
    .from(tenantNotificationRecipients)
    .where(eq(tenantNotificationRecipients.tenantId, tenantId));
  return {
    webhooks: new Map(hooks.map((hook) => [hook.id, hook.events])),
    recipients: new Map(
      recipients.map((recipient) => [
        recipient.email.trim().toLowerCase(),
        { events: recipient.events, delivery: (recipient.delivery ?? {}) as DeliveryModes },
      ]),
    ),
  };
}

/** When the rule last alerted about the subject; null when it never did. */
export async function lastRuleAlertAt(
  tx: ReportTx,
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

/** What planning one tenant's deliveries needs besides the rule and the event. */
export interface TenantPlanContext {
  readonly columns: ChannelColumns;
  /** The zone of the daily digest: the tenant's, else the installation's. */
  readonly timeZone: string;
  /** The `report_events` row of the event, when one was written. */
  readonly reportEventId?: string | null;
}

/** The tenant's own time zone, else the installation's. */
export async function tenantDigestZone(
  tx: ReportTx,
  tenantId: string,
  installationTimeZone?: InstallationZoneInput,
): Promise<string> {
  const [tenant] = await tx
    .select({ timeZone: tenants.timeZone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const own = tenant?.timeZone?.trim();
  if (own) {
    return own;
  }
  const installation =
    typeof installationTimeZone === "function"
      ? await installationTimeZone()
      : installationTimeZone;
  return installation?.trim() || environmentTimeZone(process.env).timeZone;
}

function levelOf(value: unknown): ReportEventLevel | null {
  return value === "info" || value === "warning" || value === "error" ? value : null;
}

/**
 * The outbox rows one event gives one rule: one per channel and recipient whose column has the
 * event on, none while the rule alerted about the same subject within its throttle window. A rule
 * none of whose channels wants the event queues nothing, and so does not start a throttle window.
 */
export async function planRuleDeliveries(
  tx: ReportTx,
  tenantId: string,
  rule: ReportRule,
  notification: NewNotification,
  now: Date,
  context: TenantPlanContext,
): Promise<NewReportDelivery[]> {
  const event = notification.event as ReportEvent;
  const details = notification.details ?? {};
  const subjectKey = subjectKeyOf(event, details);
  const level = levelOf(notification.level);
  const planned = plannedDeliveries(
    rule,
    "event",
    { event, columns: context.columns, level },
    { exclude: deliveryFailureExclusion(event, details) },
  );
  if (planned.length === 0) {
    return [];
  }
  if (
    isAlertThrottled(
      await lastRuleAlertAt(tx, tenantId, rule.id, subjectKey),
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
  return planned.map((delivery) => ({
    tenantId,
    ruleId: rule.id,
    ruleName: rule.name,
    kind: "event" as const,
    event,
    subjectKey,
    payload,
    channel: delivery.channel,
    recipient: delivery.recipient,
    language: rule.language,
    status: "pending" as const,
    nextAttemptAt: delivery.digest ? digestDueAt(delivery.digest, now, context.timeZone) : now,
    digest: delivery.digest ?? null,
    reportEventId: context.reportEventId ?? null,
    createdAt: now,
    updatedAt: now,
  }));
}

/** The raised notifications the bell keeps: all but the routine ones its column has off. */
async function forTheBell(
  tx: ReportTx,
  raised: readonly NewNotification[],
): Promise<NewNotification[]> {
  const bells = new Map<string, readonly string[]>();
  const written: NewNotification[] = [];
  for (const notification of raised) {
    const tenantId = notification.tenantId;
    if (
      !tenantId ||
      isFloorReportEvent(notification.event) ||
      !(ROUTINE_REPORT_EVENTS as readonly string[]).includes(notification.event)
    ) {
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

/** Write the notifications and queue the deliveries of every rule they reach. */
export async function raiseReportEvents(
  tx: ReportTx,
  raised: readonly NewNotification[],
  now: Date = new Date(),
  options: RaiseReportEventsOptions = {},
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
    // The provider's recipients learn of every catalog event through its `report_events` row.
    const eventIds = await tx
      .insert(reportEvents)
      .values(
        events.map((notification) => ({
          tenantId,
          event: notification.event,
          level: levelOf(notification.level) ?? "info",
          subjectKey: subjectKeyOf(notification.event as ReportEvent, notification.details ?? {}),
          message: notification.message,
          details: notification.details ?? {},
          occurredAt: now,
          createdAt: now,
        })),
      )
      .returning({ id: reportEvents.id });

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
    const columns = await channelColumnsOf(tx, tenantId);
    const timeZone = await tenantDigestZone(tx, tenantId, options.installationTimeZone);
    const rows: NewReportDelivery[] = [];
    for (const [index, notification] of events.entries()) {
      const event = notification.event as ReportEvent;
      for (const rule of rulesForEvent(rules, event)) {
        if (event === "backup.overdue" && overdueDeadlineOf(rule) !== null) {
          // This rule decides by its own deadline (the worker's overdue pass).
          continue;
        }
        rows.push(
          ...(await planRuleDeliveries(tx, tenantId, rule, notification, now, {
            columns,
            timeZone,
            reportEventId: eventIds[index]?.id ?? null,
          })),
        );
      }
    }
    if (rows.length > 0) {
      await tx.insert(reportDeliveries).values(rows);
    }
  }
}

/**
 * Queue one rule's deliveries of events the bell already knows about, or never will: the
 * worker's overdue pass uses it for the rules with their own `backup.overdue` deadline. Returns how
 * many rows were queued.
 */
export async function queueRuleDeliveries(
  tx: ReportTx,
  tenantId: string,
  rule: ReportRule,
  raised: readonly NewNotification[],
  now: Date,
  options: RaiseReportEventsOptions = {},
): Promise<number> {
  if (raised.length === 0) {
    return 0;
  }
  const columns = await channelColumnsOf(tx, tenantId);
  const timeZone = await tenantDigestZone(tx, tenantId, options.installationTimeZone);
  const rows: NewReportDelivery[] = [];
  for (const notification of raised) {
    rows.push(
      ...(await planRuleDeliveries(tx, tenantId, rule, notification, now, { columns, timeZone })),
    );
  }
  if (rows.length > 0) {
    await tx.insert(reportDeliveries).values(rows);
  }
  return rows.length;
}
