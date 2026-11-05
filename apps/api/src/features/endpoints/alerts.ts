import { plannedDeliveries, type ReportEvent, rulesForEvent, subjectKeyOf } from "@restow/core";
import {
  type NewNotification,
  type NewReportDelivery,
  notifications,
  reportDeliveries,
  reportRules,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import { channelColumnsOf } from "../reports/channels.js";

/**
 * Alerts the API raises itself (docs/BAREMETAL.md 12.6): the security events of a recovery (a code
 * redeemed, a dead code tried, a machine rebound) happen in an agent or ISO request, not in a
 * worker job, and must reach the tenant's admins at once. Like the worker's events
 * (apps/worker/src/reporting.ts `raiseEvents`) and the installation's (features/updates/notify.ts
 * `raiseInstallationEvent`): one row for the bell and, in the same transaction, the deliveries of
 * every enabled event rule of the tenant that lists the event, each only to the channels whose
 * column in the notification matrix has it on. No mailer of its own: the dispatcher sends them.
 * These alerts are never throttled: each one is a separate thing to look at.
 */

export interface TenantEventInput {
  tenantId: string;
  event: ReportEvent;
  level: "info" | "warning" | "error";
  /** English, for the log and the delivery log; the bell and the mails translate the event. */
  message: string;
  /** Read by the bell, the mails and the webhooks; `objectName` is the subject line's object. */
  details: Record<string, unknown> & { endpointId: string; objectName: string };
  now: Date;
}

/** Write the bell row and queue the rule deliveries of one tenant event, in the caller's transaction. */
export async function raiseTenantEvent(tx: Transaction, input: TenantEventInput): Promise<void> {
  const { tenantId, event, level, message, details, now } = input;
  const notification: NewNotification = {
    tenantId,
    level,
    event,
    message,
    details,
    createdAt: now,
  };
  await tx.insert(notifications).values(notification);

  const rules = rulesForEvent(
    await tx
      .select()
      .from(reportRules)
      .where(
        and(
          eq(reportRules.tenantId, tenantId),
          eq(reportRules.enabled, true),
          eq(reportRules.trigger, "event"),
        ),
      ),
    event,
  );
  if (rules.length === 0) {
    return;
  }
  const columns = await channelColumnsOf(tx, tenantId);
  const subjectKey = subjectKeyOf(event, details);
  const payload = { event, level, message, details, occurredAt: now.toISOString() };
  const rows: NewReportDelivery[] = [];
  for (const rule of rules) {
    for (const planned of plannedDeliveries(rule, "event", { event, columns })) {
      rows.push({
        tenantId,
        ruleId: rule.id,
        ruleName: rule.name,
        kind: "event",
        event,
        subjectKey,
        payload,
        channel: planned.channel,
        recipient: planned.recipient,
        language: rule.language,
        status: "pending",
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  if (rows.length > 0) {
    await tx.insert(reportDeliveries).values(rows);
  }
}
