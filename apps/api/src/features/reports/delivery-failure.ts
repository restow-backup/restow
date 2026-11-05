import { DELIVERY_FAILED_EVENT } from "@restow/core";
import {
  type Database,
  type MailFailureState,
  notifications,
  providerNotificationRecipients,
  type ReportDelivery,
  raiseReportEvents,
  reportDeliveries,
  settings,
  tenantNotificationRecipients,
} from "@restow/db";
import { and, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { isTransportFailureReason } from "../../notify.js";
import { raiseInstallationEvent } from "../updates/notify.js";

/**
 * Alerts about mail that cannot be delivered (0.5.0, docs/NOTIFICATIONS.md "Delivery failures"):
 * when a report delivery by e-mail ends `failed` (refused for good at once, or after its retries),
 * `notification.delivery_failed` is raised once per episode, through every channel but the one
 * that failed, and always into the bell:
 *
 *   - the mail transport as a whole (not configured, login refused, server unreachable, no token):
 *     one episode in `settings.mail_failure`, raised as an installation event (the provider's bell,
 *     and the tenants' webhooks that listen for it);
 *   - a notification recipient of a tenant or of the provider: one episode on its row, raised in
 *     the tenant (its bell, its webhooks, the provider's floor) or for the provider;
 *   - an address typed into one rule only: at most one alert per address and 24 hours.
 *
 * Every episode ends with the next successful send. A delivery that is itself such an alert never
 * raises another one: its failure is only logged and recorded. Asynchronous bounces (a delivery
 * status notification after the server accepted the mail) are not seen: the notification mail
 * has no mailbox that receives them.
 */

export interface FailedMail {
  readonly reason: string | null;
  readonly error: string;
}

const DAY_MS = 24 * 60 * 60_000;

/** Whether the delivery is itself an alert about a failed delivery (or a test send). */
export function isAlertAboutFailure(delivery: Pick<ReportDelivery, "event" | "payload">): boolean {
  const payload = delivery.payload ?? {};
  const details = (payload.details ?? {}) as Record<string, unknown>;
  return (
    delivery.event === DELIVERY_FAILED_EVENT ||
    payload.deliveryFailure === true ||
    details.deliveryFailure === true
  );
}

/** Control characters, stripped from a transport's message before it is stored. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

function detailOf(error: string): string {
  return error.replace(CONTROL_CHARACTERS, " ").trim().slice(0, 300);
}

async function failedSince(
  providerDb: Database,
  delivery: ReportDelivery,
  recipient: string,
  since: Date,
): Promise<number> {
  const [row] = await providerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.status, "failed"),
        eq(reportDeliveries.channel, "email"),
        delivery.tenantId
          ? eq(reportDeliveries.tenantId, delivery.tenantId)
          : isNull(reportDeliveries.tenantId),
        sql`lower(btrim(${reportDeliveries.recipient})) = ${recipient}`,
        gte(reportDeliveries.updatedAt, since),
      ),
    );
  return Math.max(1, row?.count ?? 1);
}

/** The transport episode: started or counted; true when this failure is the one to alert about. */
async function transportEpisode(
  providerDb: Database,
  reason: string,
  detail: string,
  now: Date,
): Promise<MailFailureState | null> {
  return providerDb.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: settings.id, mailFailure: settings.mailFailure })
      .from(settings)
      .limit(1)
      .for("update");
    if (!row) {
      return null;
    }
    const current = row.mailFailure;
    const next: MailFailureState = current
      ? { ...current, reason, detail, failedDeliveries: (current.failedDeliveries ?? 0) + 1 }
      : { since: now.toISOString(), reason, detail, alertedAt: null, failedDeliveries: 1 };
    const alert = next.alertedAt === null;
    if (alert) {
      next.alertedAt = now.toISOString();
    }
    await tx
      .update(settings)
      .set({ mailFailure: next, updatedAt: sql`${settings.updatedAt}` })
      .where(eq(settings.id, row.id));
    return alert ? next : null;
  });
}

/**
 * Record a failed e-mail delivery's episode and raise the alert when the episode is new. Returns
 * what happened, for the log and the tests.
 */
export async function onMailDeliveryFailed(
  providerDb: Database,
  db: Database,
  delivery: ReportDelivery,
  failure: FailedMail,
  now: Date,
): Promise<"ignored" | "counted" | "alerted"> {
  if (delivery.channel !== "email" || !delivery.recipient) {
    return "ignored";
  }
  if (isAlertAboutFailure(delivery) || delivery.payload?.test === true) {
    return "ignored";
  }
  const recipient = delivery.recipient.trim().toLowerCase();
  const reason = failure.reason ?? "transport_error";
  const detail = detailOf(failure.error);
  // `installation` is the transport's own audience (below): every tenant's webhooks hear of it.
  const audience: "tenant" | "provider" = delivery.tenantId ? "tenant" : "provider";
  const base = {
    channel: "email",
    audience,
    reason,
    detail,
    ruleId: delivery.ruleId,
    ruleName: delivery.ruleName,
    deliveryFailure: true,
  };

  if (isTransportFailureReason(reason)) {
    const episode = await transportEpisode(providerDb, reason, detail, now);
    if (!episode) {
      return "counted";
    }
    // The transport concerns the whole installation, no single tenant: the details name no rule
    // (the failed delivery was one tenant's, and every member of the provider team sees this
    // alert), and the audience lets the tenants' webhooks hear of it (raiseInstallationEvent).
    const { ruleId: _ruleId, ruleName: _ruleName, ...installationBase } = base;
    await providerDb.transaction((tx) =>
      raiseInstallationEvent(tx, {
        event: DELIVERY_FAILED_EVENT,
        level: "error",
        message: `Notification mail cannot be sent: ${reason}.`,
        details: {
          ...installationBase,
          audience: "installation",
          scope: "transport",
          since: episode.since,
          failedDeliveries: episode.failedDeliveries,
          objectName: "Mail",
        },
        now,
      }),
    );
    return "alerted";
  }

  // One address: a recipient's episode, or the 24 hours of an address a rule names alone.
  if (delivery.tenantId) {
    const tenantId = delivery.tenantId;
    return withTenantTx(db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(tenantNotificationRecipients)
        .where(
          and(
            eq(tenantNotificationRecipients.tenantId, tenantId),
            sql`lower(btrim(${tenantNotificationRecipients.email})) = ${recipient}`,
          ),
        )
        .limit(1)
        .for("update");
      let since = now;
      if (row) {
        since = row.failingSince ?? now;
        await tx
          .update(tenantNotificationRecipients)
          .set({
            failingSince: since,
            lastFailureReason: reason,
            ...(row.failureAlertedAt ? {} : { failureAlertedAt: now }),
          })
          .where(eq(tenantNotificationRecipients.id, row.id));
        if (row.failureAlertedAt) {
          return "counted";
        }
      } else {
        const [recent] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.tenantId, tenantId),
              eq(notifications.event, DELIVERY_FAILED_EVENT),
              sql`${notifications.details}->>'recipient' = ${recipient}`,
              gte(notifications.createdAt, new Date(now.getTime() - DAY_MS)),
            ),
          )
          .limit(1);
        if (recent) {
          return "counted";
        }
      }
      await raiseReportEvents(
        tx,
        [
          {
            tenantId,
            level: "error",
            event: DELIVERY_FAILED_EVENT,
            message: `Notification mail to ${recipient} cannot be delivered: ${reason}.`,
            details: {
              ...base,
              scope: "recipient",
              recipient,
              since: since.toISOString(),
              failedDeliveries: await failedSince(providerDb, delivery, recipient, since),
              objectName: recipient,
            },
            createdAt: now,
          },
        ],
        now,
        // The tenant role cannot read the settings: the installation pool supplies the zone.
        {
          installationTimeZone: async () => (await loadInstallationTimeZone(providerDb)).timeZone,
        },
      );
      return "alerted" as const;
    });
  }

  // A provider recipient.
  const alerted = await providerDb.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(providerNotificationRecipients)
      .where(
        delivery.providerRecipientId
          ? eq(providerNotificationRecipients.id, delivery.providerRecipientId)
          : sql`lower(btrim(${providerNotificationRecipients.email})) = ${recipient}`,
      )
      .limit(1)
      .for("update");
    if (!row) {
      return null;
    }
    const since = row.failingSince ?? now;
    await tx
      .update(providerNotificationRecipients)
      .set({
        failingSince: since,
        lastFailureReason: reason,
        ...(row.failureAlertedAt ? {} : { failureAlertedAt: now }),
      })
      .where(eq(providerNotificationRecipients.id, row.id));
    return row.failureAlertedAt ? null : since;
  });
  if (!alerted) {
    return "counted";
  }
  const failedDeliveries = await failedSince(providerDb, delivery, recipient, alerted);
  await providerDb.transaction((tx) =>
    raiseInstallationEvent(tx, {
      event: DELIVERY_FAILED_EVENT,
      level: "error",
      message: `Notification mail to ${recipient} cannot be delivered: ${reason}.`,
      details: {
        ...base,
        scope: "recipient",
        recipient,
        since: alerted.toISOString(),
        failedDeliveries,
        objectName: recipient,
      },
      now,
    }),
  );
  return "alerted";
}

/** A sent e-mail ends the transport's episode and its recipient's. */
export async function onMailDeliverySucceeded(
  providerDb: Database,
  db: Database,
  delivery: Pick<ReportDelivery, "tenantId" | "recipient" | "providerRecipientId" | "channel">,
): Promise<void> {
  if (delivery.channel !== "email" || !delivery.recipient) {
    return;
  }
  await providerDb
    .update(settings)
    .set({ mailFailure: null, updatedAt: sql`${settings.updatedAt}` })
    .where(isNotNull(settings.mailFailure));
  const recipient = delivery.recipient.trim().toLowerCase();
  const reset = { failingSince: null, failureAlertedAt: null, lastFailureReason: null };
  if (delivery.tenantId) {
    const tenantId = delivery.tenantId;
    await withTenantTx(db, tenantId, (tx) =>
      tx
        .update(tenantNotificationRecipients)
        .set(reset)
        .where(
          and(
            eq(tenantNotificationRecipients.tenantId, tenantId),
            sql`lower(btrim(${tenantNotificationRecipients.email})) = ${recipient}`,
            isNotNull(tenantNotificationRecipients.failingSince),
          ),
        ),
    );
    return;
  }
  await providerDb
    .update(providerNotificationRecipients)
    .set(reset)
    .where(
      and(
        sql`lower(btrim(${providerNotificationRecipients.email})) = ${recipient}`,
        isNotNull(providerNotificationRecipients.failingSince),
      ),
    );
}
