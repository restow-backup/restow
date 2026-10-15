import {
  bellEventsOf,
  catalogEventsOf,
  isInstallationReportEvent,
  REPORT_EVENT_INFO,
  REPORT_EVENTS,
  type ReportEvent,
  webhookColumnUpdate,
} from "@restow/core";
import { type Database, tenantNotificationRecipients, tenants, webhooks } from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { featureEnabled } from "../../lib/features.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { normalizeRecipientEvents, syncRecipientRules, WEEKLY_REPORT_ENTRY } from "./defaults.js";
import type { UpdateNotificationMatrixInput } from "./schemas.js";
import type { ReportActor } from "./service.js";

/**
 * The notification matrix of a tenant (docs/ARCHITECTURE.md, Reports and notifications): the
 * events of the catalog as rows, the tenant's channels as columns (the bell, every webhook, every
 * notification recipient), a cell on when the channel gets the event. Each channel stores its own
 * column (`tenants.bell_events`, `webhooks.events`, `tenant_notification_recipients.events`);
 * the worker and the dispatcher read them where events become deliveries. Installation events
 * (an update is available) are rows for provider administrators only; a tenant administrator's
 * save leaves them as they were.
 */

export const MATRIX_AUDIT_ACTIONS = { updated: "report.matrix_updated" } as const;

export interface MatrixEventDto {
  name: ReportEvent;
  group: string;
  level: string;
}

export type MatrixChannelDto =
  | { kind: "bell"; id: "bell"; events: ReportEvent[]; custom: boolean }
  | {
      kind: "webhook";
      id: string;
      name: string | null;
      /** Scheme and host of the URL only: some receivers carry their token in the path. */
      host: string;
      format: string;
      active: boolean;
      events: ReportEvent[];
    }
  | {
      kind: "email";
      id: string;
      email: string;
      name: string | null;
      events: ReportEvent[];
      weeklyReport: boolean;
    };

export interface NotificationMatrixDto {
  events: MatrixEventDto[];
  channels: MatrixChannelDto[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The rows a viewer sees: installation events only for provider administrators. */
function visibleEvents(providerAdmin: boolean): ReportEvent[] {
  return REPORT_EVENTS.filter((event) => providerAdmin || !isInstallationReportEvent(event));
}

export async function getNotificationMatrix(
  db: Database,
  tenantId: string,
  options: { providerAdmin: boolean },
): Promise<NotificationMatrixDto> {
  const visible = visibleEvents(options.providerAdmin);
  const only = (events: readonly string[]) =>
    catalogEventsOf(events).filter((event) => visible.includes(event));
  return withTenantTx(db, tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ bellEvents: tenants.bellEvents })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) {
      throw new ProblemError(404, "Tenant not found");
    }
    const hooks = await tx
      .select()
      .from(webhooks)
      .where(eq(webhooks.tenantId, tenantId))
      .orderBy(asc(webhooks.createdAt), asc(webhooks.id));
    const recipients = await tx
      .select()
      .from(tenantNotificationRecipients)
      .where(eq(tenantNotificationRecipients.tenantId, tenantId))
      // Saved as one list, so they share a timestamp: the address decides then.
      .orderBy(
        asc(tenantNotificationRecipients.createdAt),
        asc(tenantNotificationRecipients.email),
      );
    return {
      events: visible.map((name) => ({
        name,
        group: REPORT_EVENT_INFO[name].group,
        level: REPORT_EVENT_INFO[name].level,
      })),
      channels: [
        {
          kind: "bell",
          id: "bell",
          events: only(bellEventsOf(tenant.bellEvents)),
          custom: tenant.bellEvents !== null,
        },
        ...hooks.map((hook) => ({
          kind: "webhook" as const,
          id: hook.id,
          name: hook.name,
          host: hostOf(hook.url),
          format: hook.format,
          active: hook.active,
          events: only(hook.events),
        })),
        ...recipients.map((recipient) => ({
          kind: "email" as const,
          id: recipient.id,
          email: recipient.email,
          name: recipient.name,
          events: only(recipient.events),
          weeklyReport: recipient.events.includes(WEEKLY_REPORT_ENTRY),
        })),
      ],
    };
  });
}

/**
 * A column as saved: the catalog events asked for among the rows the viewer sees, plus whatever
 * the viewer does not see and the column already had (installation events for a tenant
 * administrator).
 */
function savedColumn(
  requested: readonly string[],
  before: readonly string[],
  visible: readonly ReportEvent[],
): ReportEvent[] {
  return catalogEventsOf([
    ...requested.filter((event) => visible.includes(event as ReportEvent)),
    ...before.filter((event) => !visible.includes(event as ReportEvent)),
  ]);
}

/**
 * Save the columns of the channels in `input` (the others stay as they are) and bring the
 * recipients' rules up to date, in one transaction, audited with the channels' ids and how many
 * events each one has, never an address.
 */
export async function updateNotificationMatrix(
  db: Database,
  tenantId: string,
  input: UpdateNotificationMatrixInput,
  actor: ReportActor,
  now: Date,
): Promise<NotificationMatrixDto> {
  const providerAdmin = actor.providerAdmin === true;
  const visible = visibleEvents(providerAdmin);
  const scheduledAllowed = await featureEnabled("reports.timed");
  await withTenantTx(db, tenantId, async (tx) => {
    const [tenant] = await tx
      .select({
        bellEvents: tenants.bellEvents,
        language: tenants.language,
        timeZone: tenants.timeZone,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) {
      throw new ProblemError(404, "Tenant not found");
    }
    const changed: Record<string, number> = {};
    let recipientsChanged = false;
    for (const channel of input.channels) {
      if (channel.kind === "bell") {
        const events = savedColumn(channel.events, bellEventsOf(tenant.bellEvents), visible);
        await tx
          .update(tenants)
          .set({ bellEvents: events, updatedAt: now })
          .where(eq(tenants.id, tenantId));
        changed.bell = events.length;
        continue;
      }
      if (channel.kind === "webhook") {
        const [hook] = await tx
          .select({ events: webhooks.events })
          .from(webhooks)
          .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, channel.id)));
        if (!hook) {
          throw new ProblemError(404, "Webhook not found");
        }
        const events = savedColumn(channel.events, hook.events, visible);
        await tx
          .update(webhooks)
          .set({ events: webhookColumnUpdate(hook.events, events), updatedAt: now })
          .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, channel.id)));
        changed[`webhook:${channel.id}`] = events.length;
        continue;
      }
      const [recipient] = await tx
        .select({ events: tenantNotificationRecipients.events })
        .from(tenantNotificationRecipients)
        .where(
          and(
            eq(tenantNotificationRecipients.tenantId, tenantId),
            eq(tenantNotificationRecipients.id, channel.id),
          ),
        );
      if (!recipient) {
        throw new ProblemError(404, "Notification recipient not found");
      }
      const events = savedColumn(channel.events, recipient.events, visible);
      const weekly = recipient.events.includes(WEEKLY_REPORT_ENTRY) ? [WEEKLY_REPORT_ENTRY] : [];
      await tx
        .update(tenantNotificationRecipients)
        .set({ events: normalizeRecipientEvents([...events, ...weekly]), updatedAt: now })
        .where(
          and(
            eq(tenantNotificationRecipients.tenantId, tenantId),
            eq(tenantNotificationRecipients.id, channel.id),
          ),
        );
      changed[`email:${channel.id}`] = events.length;
      recipientsChanged = true;
    }
    let rules = null;
    if (recipientsChanged) {
      const all = await tx
        .select({
          email: tenantNotificationRecipients.email,
          events: tenantNotificationRecipients.events,
        })
        .from(tenantNotificationRecipients)
        .where(eq(tenantNotificationRecipients.tenantId, tenantId));
      // The rules are what sends: they follow the recipients in the same transaction.
      rules = await syncRecipientRules(tx, {
        tenantId,
        recipients: all,
        previous: all,
        language: tenant.language,
        timeZone: tenant.timeZone,
        createdBy: actor.userId,
        scheduledAllowed,
        now,
      });
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: MATRIX_AUDIT_ACTIONS.updated,
      target: tenantId,
      targetType: "tenant",
      ip: actor.ip,
      // Channel ids and how many events each one gets now, never an address.
      details: { events: changed, ...(rules ? { rules } : {}) },
    });
  });
  return getNotificationMatrix(db, tenantId, { providerAdmin });
}
