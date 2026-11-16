import {
  type DeliveryModes,
  deliveryFailureExclusion,
  deliveryModeFor,
  digestDueAt,
  isAlertThrottled,
  isFloorReportEvent,
  isReportEvent,
  type ReportEventLevel,
} from "@restow/core";
import {
  type Database,
  type NewReportDelivery,
  type ProviderNotificationRecipient,
  providerNotificationRecipients,
  type ReportEventRow,
  reportDeliveries,
  reportEvents,
  settings,
} from "@restow/db";
import { createI18n, defaultLanguage } from "@restow/i18n";
import { and, eq, inArray, isNotNull, lt, max, sql } from "drizzle-orm";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import { isFloorRecipient, syncOwnerRecipients } from "../provider-notifications/service.js";
import { notificationMailConfigured } from "../settings/service.js";

/**
 * The fan-out to the provider's recipients (0.5.0, docs/NOTIFICATIONS.md): every event that reached
 * the rules has a `report_events` row (the worker and the API write it with the event, in the
 * tenant's transaction). The dispatcher claims the rows not yet fanned out, across tenants, and
 * plans one e-mail per provider recipient that wants the event:
 *
 *   - its column has the event, or it is on the floor (an owner, or mandatory) and the event is a
 *     critical one or a failed delivery;
 *   - not to an address that already got this event through a tenant rule (one mail is enough);
 *   - at most once per recipient and subject within 60 minutes for warnings and errors (the
 *     critical events too); notices are not held back;
 *   - never to the address (or while the transport is down, through e-mail at all) whose failure
 *     the event is about;
 *   - at once, or held for the recipient's digest (installation time zone);
 *   - not at all while no mail transport is configured and the operator marked the mail as not
 *     needed (the Start checklist): such an installation stays as quiet as until 0.4, the events
 *     still reach the bell.
 *
 * The rows carry no tenant (`tenant_id` null, `about_tenant_id` the tenant the event is about), so
 * Row Level Security keeps the provider's addresses out of every tenant session.
 */

const FAN_OUT_BATCH = 200;
const THROTTLE_MINUTES = 60;

function levelOf(value: string): ReportEventLevel {
  return value === "error" || value === "warning" ? value : "info";
}

/** Whether a provider recipient gets `event` (its column, or the floor's events). */
export function providerRecipientWants(
  recipient: Pick<ProviderNotificationRecipient, "events" | "kind" | "mandatory">,
  event: string,
): boolean {
  return (
    recipient.events.includes(event) || (isFloorRecipient(recipient) && isFloorReportEvent(event))
  );
}

async function lastProviderAlertAt(
  tx: Pick<Database, "select">,
  recipientId: string,
  subjectKey: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ at: max(reportDeliveries.createdAt) })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.providerRecipientId, recipientId),
        eq(reportDeliveries.subjectKey, subjectKey),
        eq(reportDeliveries.kind, "event"),
      ),
    );
  return row?.at ?? null;
}

/** The provider rows one event gives. */
export async function providerDeliveriesFor(
  tx: Pick<Database, "select">,
  event: ReportEventRow,
  recipients: readonly ProviderNotificationRecipient[],
  context: { now: Date; timeZone: string; ruleName: string },
): Promise<NewReportDelivery[]> {
  if (!isReportEvent(event.event)) {
    return [];
  }
  const details = event.details ?? {};
  const exclude = deliveryFailureExclusion(event.event, details);
  const level = levelOf(event.level);
  const already = await tx
    .select({ recipient: reportDeliveries.recipient })
    .from(reportDeliveries)
    .where(
      and(eq(reportDeliveries.reportEventId, event.id), eq(reportDeliveries.channel, "email")),
    );
  const mailed = new Set(already.map((row) => (row.recipient ?? "").trim().toLowerCase()));
  const rows: NewReportDelivery[] = [];
  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!providerRecipientWants(recipient, event.event)) continue;
    if (exclude.allEmail || exclude.email === email || mailed.has(email)) continue;
    mailed.add(email);
    const throttle = level === "info" ? 0 : THROTTLE_MINUTES;
    if (
      throttle > 0 &&
      isAlertThrottled(
        await lastProviderAlertAt(tx, recipient.id, event.subjectKey),
        context.now,
        throttle,
      )
    ) {
      continue;
    }
    const mode = deliveryModeFor(recipient.delivery as DeliveryModes, event.event, level);
    const digest = mode === "immediate" ? null : mode;
    rows.push({
      tenantId: null,
      aboutTenantId: event.tenantId,
      ruleId: null,
      providerRecipientId: recipient.id,
      ruleName: context.ruleName,
      kind: "event",
      event: event.event,
      subjectKey: event.subjectKey,
      payload: {
        event: event.event,
        level,
        message: event.message,
        details,
        occurredAt: event.occurredAt.toISOString(),
        ...(event.tenantId ? { tenantId: event.tenantId } : {}),
      },
      channel: "email",
      recipient: email,
      language: recipient.language,
      status: "pending",
      nextAttemptAt: digest ? digestDueAt(digest, context.now, context.timeZone) : context.now,
      digest,
      reportEventId: event.id,
      createdAt: context.now,
      updatedAt: context.now,
    });
  }
  return rows;
}

/** One pass of the fan-out; returns how many events were handled. */
export async function fanOutOnce(providerDb: Database, now: Date): Promise<number> {
  const [pending] = await providerDb
    .select({ id: reportEvents.id })
    .from(reportEvents)
    .where(sql`${reportEvents.fannedOutAt} IS NULL`)
    .limit(1);
  if (!pending) {
    return 0;
  }
  await syncOwnerRecipients(providerDb, now, { throttle: true });
  const [mail] = await providerDb
    .select({
      mailTransport: settings.mailTransport,
      mailConfig: settings.mailConfig,
      mailNotNeeded: settings.mailNotNeeded,
    })
    .from(settings)
    .limit(1);
  const mailNotNeeded = Boolean(mail?.mailNotNeeded) && !notificationMailConfigured(mail);
  const timeZone = (await loadInstallationTimeZone(providerDb)).timeZone;
  const ruleName = String(createI18n({ lng: defaultLanguage }).t("reports:defaultRules.provider"));
  return providerDb.transaction(async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id FROM report_events
       WHERE fanned_out_at IS NULL
       ORDER BY created_at
       LIMIT ${FAN_OUT_BATCH}
       FOR UPDATE SKIP LOCKED`);
    const ids = result.rows.map((row) => String(row.id));
    if (ids.length === 0) {
      return 0;
    }
    const events = await tx.select().from(reportEvents).where(inArray(reportEvents.id, ids));
    const recipients = await tx.select().from(providerNotificationRecipients);
    // In creation order, each event's rows written before the next is planned: a repeat of the
    // same subject in one batch is throttled like one in the next.
    events.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    for (const event of mailNotNeeded ? [] : events) {
      const rows = await providerDeliveriesFor(tx, event, recipients, { now, timeZone, ruleName });
      if (rows.length > 0) {
        await tx.insert(reportDeliveries).values(rows);
      }
    }
    await tx.update(reportEvents).set({ fannedOutAt: now }).where(inArray(reportEvents.id, ids));
    return ids.length;
  });
}

/** Delete the events fanned out more than a week ago. */
export async function pruneReportEvents(providerDb: Database, now: Date): Promise<number> {
  const deleted = await providerDb
    .delete(reportEvents)
    .where(
      and(
        isNotNull(reportEvents.fannedOutAt),
        lt(reportEvents.fannedOutAt, new Date(now.getTime() - 7 * 24 * 60 * 60_000)),
      ),
    )
    .returning({ id: reportEvents.id });
  return deleted.length;
}
