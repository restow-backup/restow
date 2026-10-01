import { plannedDeliveries, subjectKeyOf } from "@restow/core";
import {
  type Database,
  type NewNotification,
  type NewReportDelivery,
  type StoredUpdateRelease,
  notifications,
  reportDeliveries,
  reportRules,
  settings,
  tenants,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { compareVersions, parseVersion } from "../../routes/v1/version.js";

/**
 * "An update is available" (docs/ARCHITECTURE.md, Updates and Reports): raised
 * once per new version, whichever way the check ran.
 *
 * - The bell: one installation-level notification (no tenant), which provider
 *   administrators see next to their tenant's notifications.
 * - The alert rules: every tenant's enabled event rule that lists
 *   `update.available` queues its deliveries (e-mail, webhook) exactly like a
 *   failed backup would, in the same outbox the dispatcher sends from.
 *
 * "Once per version" is a claim on `settings.update_notified_version`, taken in
 * the same transaction that writes the notification and the deliveries: two
 * processes checking at the same moment cannot both raise it, and a version at
 * or below the last announced one is never announced again.
 */

export const UPDATE_AVAILABLE_EVENT = "update.available";

export interface UpdateAvailable {
  release: Pick<StoredUpdateRelease, "version" | "tag" | "url" | "publishedAt">;
  running: string | null;
}

export type NotifyOutcome = "raised" | "already_notified" | "no_settings";

export async function raiseUpdateAvailable(
  db: Database,
  input: UpdateAvailable,
  now: Date = new Date(),
): Promise<NotifyOutcome> {
  const target = parseVersion(input.release.version);
  if (!target) {
    return "already_notified";
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: settings.id, notified: settings.updateNotifiedVersion })
      .from(settings)
      .limit(1)
      .for("update");
    if (!row) {
      return "no_settings";
    }
    const notified = row.notified ? parseVersion(row.notified) : null;
    if (notified && compareVersions(target, notified) <= 0) {
      return "already_notified";
    }
    await tx
      .update(settings)
      .set({ updateNotifiedVersion: input.release.version, updatedAt: sql`${settings.updatedAt}` })
      .where(eq(settings.id, row.id));

    const details: Record<string, unknown> = {
      version: input.release.version,
      tag: input.release.tag,
      running: input.running,
      url: input.release.url,
      publishedAt: input.release.publishedAt,
      // Read by the alert mail as the subject of the message.
      objectName: input.release.version,
    };
    const message = input.running
      ? `Version ${input.release.version} is available (running ${input.running}).`
      : `Version ${input.release.version} is available.`;
    const notification: NewNotification = {
      tenantId: null,
      level: "info",
      event: UPDATE_AVAILABLE_EVENT,
      message,
      details,
      createdAt: now,
    };
    await tx.insert(notifications).values(notification);

    const rules = await tx
      .select({
        id: reportRules.id,
        tenantId: reportRules.tenantId,
        name: reportRules.name,
        enabled: reportRules.enabled,
        trigger: reportRules.trigger,
        events: reportRules.events,
        throttleMinutes: reportRules.throttleMinutes,
        emailRecipients: reportRules.emailRecipients,
        inApp: reportRules.inApp,
        webhookId: reportRules.webhookId,
        language: reportRules.language,
      })
      .from(reportRules)
      .innerJoin(tenants, eq(tenants.id, reportRules.tenantId))
      .where(
        and(
          eq(reportRules.enabled, true),
          eq(reportRules.trigger, "event"),
          eq(tenants.status, "active"),
          sql`${UPDATE_AVAILABLE_EVENT} = ANY(${reportRules.events})`,
        ),
      );

    const subjectKey = subjectKeyOf(UPDATE_AVAILABLE_EVENT, details);
    const payload = {
      event: UPDATE_AVAILABLE_EVENT,
      level: "info",
      message,
      details,
      occurredAt: now.toISOString(),
    };
    const rows: NewReportDelivery[] = [];
    for (const rule of rules) {
      for (const planned of plannedDeliveries(rule, "event")) {
        rows.push({
          tenantId: rule.tenantId,
          ruleId: rule.id,
          ruleName: rule.name,
          kind: "event",
          event: UPDATE_AVAILABLE_EVENT,
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
    return "raised";
  });
}
