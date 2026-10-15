import { type ChannelColumns, plannedDeliveries, subjectKeyOf } from "@restow/core";
import {
  type Database,
  type NewNotification,
  type NewReportDelivery,
  notifications,
  reportDeliveries,
  reportRules,
  type StoredUpdateRelease,
  settings,
  tenants,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { compareVersions, parseVersion } from "../../routes/v1/version.js";
import { channelColumnsOf } from "../reports/channels.js";

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
    await raiseInstallationEvent(tx, {
      event: UPDATE_AVAILABLE_EVENT,
      level: "info",
      message,
      details,
      now,
    });
    return "raised";
  });
}

/** The transaction of {@link raiseUpdateAvailable} (or any other installation-level writer). */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface InstallationEventInput {
  event: "update.available" | "installation.disk_low";
  level: "info" | "warning" | "error";
  /** English, for the log and the delivery log; the bell and the mails translate the event. */
  message: string;
  /** Read by the bell, the mails and the webhooks; `objectName` is the subject line's object. */
  details: Record<string, unknown>;
  now: Date;
}

/**
 * An installation event (not about one tenant's data): one notification without a tenant,
 * which provider administrators see in the bell, and the deliveries of every tenant's
 * enabled event rule that lists the event, in the same outbox a failed backup's alert goes
 * through, each only to the channels whose column in the notification matrix has it on.
 * Runs inside the caller's transaction, so the caller's "once" claim and the alert commit
 * together.
 */
export async function raiseInstallationEvent(tx: Tx, input: InstallationEventInput): Promise<void> {
  const { event, level, message, details, now } = input;
  const notification: NewNotification = {
    tenantId: null,
    level,
    event,
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
        sql`${event} = ANY(${reportRules.events})`,
      ),
    );

  const subjectKey = subjectKeyOf(event, details);
  const payload = { event, level, message, details, occurredAt: now.toISOString() };
  const rows: NewReportDelivery[] = [];
  const columns = new Map<string, ChannelColumns>();
  for (const rule of rules) {
    let tenantColumns = columns.get(rule.tenantId);
    if (!tenantColumns) {
      tenantColumns = await channelColumnsOf(tx, rule.tenantId);
      columns.set(rule.tenantId, tenantColumns);
    }
    // Only the channels whose column has the event on (the notification matrix).
    const channels = { event, columns: tenantColumns };
    for (const planned of plannedDeliveries(rule, "event", channels)) {
      rows.push({
        tenantId: rule.tenantId,
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
