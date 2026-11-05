import { type ChannelColumns, DELIVERY_FAILED_EVENT, subjectKeyOf } from "@restow/core";
import {
  type Database,
  type NewNotification,
  type NewReportDelivery,
  notifications,
  planRuleDeliveries,
  reportDeliveries,
  reportEvents,
  reportRules,
  type StoredUpdateRelease,
  settings,
  tenantDigestZone,
  tenants,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
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
  event:
    | "update.available"
    | "installation.disk_low"
    | "installation.app_secret_expiring"
    | "installation.restore_mode"
    | "installation.key_mirror_conflict"
    | "notification.delivery_failed";
  level: "info" | "warning" | "error";
  /** English, for the log and the delivery log; the bell and the mails translate the event. */
  message: string;
  /** Read by the bell, the mails and the webhooks; `objectName` is the subject line's object. */
  details: Record<string, unknown>;
  now: Date;
}

/**
 * An installation event (not about one tenant's data): one notification without a tenant,
 * which provider administrators see in the bell, a `report_events` row the dispatcher fans out to
 * the provider's recipients (features/reports/fanout.ts), and the deliveries of every tenant's
 * enabled event rule that lists the event, in the same outbox a failed backup's alert goes
 * through, each only to the channels whose column in the notification matrix has it on (at once,
 * or held for a recipient's digest). A failed delivery of the provider's own (a provider
 * recipient's address, `audience: "provider"`) concerns no tenant and reaches no tenant rule; the
 * mail transport being down (`audience: "installation"`, `scope: "transport"`) reaches the
 * tenants' webhooks (never their e-mail, deliveryFailureExclusion). Runs inside the caller's
 * transaction, so the caller's "once" claim and the alert commit together.
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

  const subjectKey = subjectKeyOf(event, details);
  const [reportEvent] = await tx
    .insert(reportEvents)
    .values({
      tenantId: null,
      event,
      level,
      subjectKey,
      message,
      details,
      occurredAt: now,
      createdAt: now,
    })
    .returning({ id: reportEvents.id });

  if (event === DELIVERY_FAILED_EVENT && details.audience === "provider") {
    return;
  }

  const rules = await tx
    .select({ rule: reportRules })
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

  const installationZone = (await loadInstallationTimeZone(tx)).timeZone;
  const rows: NewReportDelivery[] = [];
  const contexts = new Map<string, { columns: ChannelColumns; timeZone: string }>();
  for (const { rule } of rules) {
    let context = contexts.get(rule.tenantId);
    if (!context) {
      context = {
        columns: await channelColumnsOf(tx, rule.tenantId),
        timeZone: await tenantDigestZone(tx, rule.tenantId, installationZone),
      };
      contexts.set(rule.tenantId, context);
    }
    // Only the channels whose column has the event on (the notification matrix).
    rows.push(
      ...(await planRuleDeliveries(tx, rule.tenantId, rule, notification, now, {
        ...context,
        reportEventId: reportEvent?.id ?? null,
      })),
    );
  }
  if (rows.length > 0) {
    await tx.insert(reportDeliveries).values(rows);
  }
}
