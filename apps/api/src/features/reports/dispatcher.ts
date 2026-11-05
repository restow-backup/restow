import { randomUUID } from "node:crypto";
import { MAX_REPORT_ATTEMPTS, monthPeriod, nextAttemptAfter } from "@restow/core";
import {
  type Database,
  notifications,
  providerNotificationRecipients,
  type ReportDelivery,
  reportDeliveries,
  tenantNotificationRecipients,
  tenants,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { createI18n, defaultLanguage, type SupportedLanguage } from "@restow/i18n";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BackgroundService } from "../../extensions.js";
import { featureHook } from "../../extensions.js";
import { featureEnabled } from "../../lib/features.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { MailAttachment, NotificationMessage, Notifier } from "../../notify.js";
import {
  effectiveBrand,
  type LoadedBrand,
  mailBrandOf,
  pdfBrandOf,
  pruneRetiredImages,
} from "../branding/service.js";
import {
  isAlertAboutFailure,
  onMailDeliveryFailed,
  onMailDeliverySucceeded,
} from "./delivery-failure.js";
import { fanOutOnce, providerRecipientWants, pruneReportEvents } from "./fanout.js";
import {
  type DigestItem,
  type MailBrand,
  type RenderedMessage,
  renderAlert,
  renderDigest,
} from "./render.js";
import "./hooks.js";

/**
 * The report outbox dispatcher (docs/ARCHITECTURE.md, Reports and
 * notifications): a loop in the API process that, per tick,
 *
 *   1. fans the new events out to the provider's recipients (fanout.ts),
 *   2. sends the digests that are due, one mail per recipient and window,
 *   3. claims the due rows of `report_deliveries` across tenants (FOR UPDATE SKIP LOCKED plus a
 *      lease, so several API processes never send the same row twice and a crashed one only
 *      delays it), renders them in the rule's or tenant's language and brand and sends them:
 *      e-mail through the installation's mail transport (Settings), the bell as an in-app
 *      notification, a webhook as a signed delivery the worker's webhook dispatcher sends,
 *   4. raises `notification.delivery_failed` for a mail that finally failed (delivery-failure.ts),
 *   5. prunes, once an hour, the fanned-out events and the retired logos.
 *
 * Failures are retried with backoff and then given up; a recipient the mail server refused for
 * good is not retried. Every outcome stays in the delivery log.
 */

const CLAIM_BATCH = 20;
const DIGEST_BATCH = 20;

/** Where a handed-over webhook alert keeps the id of its `webhook_deliveries` row. */
export const WEBHOOK_DELIVERY_KEY = "webhookDeliveryId";
const LEASE_SECONDS = 120;
const POLL_MS = 15_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;

export interface DispatcherDeps {
  /** Installation pool (BYPASSRLS): claims and records across tenants. */
  readonly providerDb: Database;
  /** Tenant pool: report figures are read tenant-pinned, like any request. */
  readonly db: Database;
  /** The mail transport from the settings; null while none is configured. */
  readonly notifier: () => Promise<Notifier | null>;
  readonly now?: () => Date;
  /**
   * Public demo: nothing may leave the server, so e-mail and webhook
   * deliveries are recorded as skipped (the log then says why) instead of
   * pretending they were sent. Bell entries stay, they are local.
   */
  readonly demo?: boolean;
  readonly log?: (level: "info" | "warn" | "error", message: string, fields?: object) => void;
}

export type Outcome =
  | {
      status: "sent";
      /**
       * A webhook delivery is only handed over here: the worker sends it. Its id is kept on the
       * row (`payload.webhookDeliveryId`) so the log shows the webhook's own outcome.
       */
      webhookDeliveryId?: string;
    }
  | { status: "skipped"; reason: string }
  | {
      status: "retry";
      error: string;
      /** The transport's reason code, when it named one. */
      reason?: string;
      /** A retry cannot help: the row fails at once. */
      permanent?: boolean;
    };

/** Claim the due rows (attempt counted, lease set); digest rows wait for their digest. */
export async function claimDue(db: Database, now: Date): Promise<ReportDelivery[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    UPDATE report_deliveries
       SET attempts = attempts + 1,
           lease_until = ${new Date(now.getTime() + LEASE_SECONDS * 1000)},
           updated_at = ${now}
     WHERE id IN (
       SELECT id FROM report_deliveries
        WHERE status = 'pending'
          AND digest IS NULL
          AND next_attempt_at <= ${now}
          AND (lease_until IS NULL OR lease_until < ${now})
        ORDER BY next_attempt_at
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED)
    RETURNING id`);
  const ids = result.rows.map((row) => String(row.id));
  if (ids.length === 0) return [];
  return db
    .select()
    .from(reportDeliveries)
    .where(
      sql`${reportDeliveries.id} IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
}

interface Audience {
  /** The tenant the message is about, or the installation's own label. */
  name: string;
  language: SupportedLanguage | null;
  /** The tenant whose brand applies; null for the provider's own messages. */
  brandTenantId: string | null;
}

async function tenantRow(db: Database, tenantId: string) {
  const [row] = await db
    .select({ name: tenants.name, language: tenants.language })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ?? null;
}

/** Who a row speaks to: a tenant's own, or the provider's (about a tenant or the installation). */
async function audienceOf(db: Database, delivery: ReportDelivery): Promise<Audience> {
  if (delivery.tenantId) {
    const row = await tenantRow(db, delivery.tenantId);
    return {
      name: row?.name ?? delivery.tenantId,
      language: row?.language ?? null,
      brandTenantId: delivery.tenantId,
    };
  }
  const about = delivery.aboutTenantId ? await tenantRow(db, delivery.aboutTenantId) : null;
  const language: SupportedLanguage = delivery.language ?? defaultLanguage;
  return {
    name: about?.name ?? String(createI18n({ lng: language }).t("reports:mail.installation")),
    language: null,
    brandTenantId: null,
  };
}

/** Record what happened to a claimed row; returns the status it ends with. */
export async function recordOutcome(
  db: Database,
  delivery: ReportDelivery,
  outcome: Outcome,
  now: Date,
): Promise<"sent" | "skipped" | "pending" | "failed"> {
  if (outcome.status === "sent") {
    await db
      .update(reportDeliveries)
      .set({
        status: "sent",
        sentAt: now,
        leaseUntil: null,
        lastError: null,
        updatedAt: now,
        ...(outcome.webhookDeliveryId
          ? {
              payload: {
                ...(delivery.payload ?? {}),
                [WEBHOOK_DELIVERY_KEY]: outcome.webhookDeliveryId,
              },
            }
          : {}),
      })
      .where(eq(reportDeliveries.id, delivery.id));
    return "sent";
  }
  if (outcome.status === "skipped") {
    await db
      .update(reportDeliveries)
      .set({ status: "skipped", leaseUntil: null, lastError: outcome.reason, updatedAt: now })
      .where(eq(reportDeliveries.id, delivery.id));
    return "skipped";
  }
  const next =
    outcome.permanent || delivery.attempts >= MAX_REPORT_ATTEMPTS
      ? null
      : nextAttemptAfter(delivery.attempts, now);
  await db
    .update(reportDeliveries)
    .set({
      status: next ? "pending" : "failed",
      nextAttemptAt: next ?? delivery.nextAttemptAt,
      leaseUntil: null,
      lastError: outcome.error.slice(0, 500),
      updatedAt: now,
    })
    .where(eq(reportDeliveries.id, delivery.id));
  return next ? "pending" : "failed";
}

interface Built {
  message: RenderedMessage;
  headline: Record<string, unknown>;
  attachments: MailAttachment[];
  brand: ReturnType<typeof mailBrandOf>;
}

/** Build the message of a row, or say why it cannot be built. */
async function render(
  deps: DispatcherDeps,
  delivery: ReportDelivery,
  audience: Audience,
): Promise<Built | { skip: string }> {
  const language: SupportedLanguage = delivery.language ?? audience.language ?? defaultLanguage;
  const payload = delivery.payload ?? {};
  const test = payload.test === true;
  const loaded: LoadedBrand = await effectiveBrand(deps.providerDb, audience.brandTenantId);
  const brand = mailBrandOf(loaded, "cid");
  if (delivery.kind === "event") {
    return {
      message: renderAlert({
        language,
        tenantName: audience.name,
        ruleName: delivery.ruleName,
        payload,
        test,
        brand: brand.brand,
      }),
      headline: { event: delivery.event },
      attachments: [],
      brand,
    };
  }
  const attachPdf = payload.attachPdf === true;
  const pdfBrand = attachPdf ? pdfBrandOf(loaded) : null;
  if (payload.kind === "customer") {
    const renderer = featureHook("reportCustomer");
    if (
      !renderer ||
      !delivery.tenantId ||
      !(await featureEnabled("reports.customer", deps.providerDb))
    ) {
      return { skip: "not_available" };
    }
    const tenantId = delivery.tenantId;
    const month =
      typeof payload.month === "string" && monthPeriod(payload.month, "UTC") ? payload.month : "";
    if (!month) {
      return { skip: "not_available" };
    }
    const rendered = await withTenantTx(deps.db, tenantId, (tx) =>
      renderer.render({
        db: tx,
        providerDb: deps.providerDb,
        tenantPool: deps.db,
        scope: "tenant",
        tenantId,
        tenantName: audience.name,
        ruleName: delivery.ruleName,
        language,
        payload,
        test,
        brand: brand.brand,
        attachPdf: true,
        pdfBrand: pdfBrandOf(loaded),
        month,
      }),
    );
    return {
      message: rendered,
      headline: rendered.headline,
      attachments: rendered.attachments ?? [],
      brand,
    };
  }
  const renderer = featureHook("reportSummary");
  if (!renderer || !(await featureEnabled("reports.timed", deps.providerDb))) {
    return { skip: "not_available" };
  }
  const common = {
    providerDb: deps.providerDb,
    tenantPool: deps.db,
    tenantName: audience.name,
    ruleName: delivery.ruleName,
    language,
    payload,
    test,
    brand: brand.brand,
    attachPdf,
    pdfBrand,
  };
  const rendered =
    payload.scope === "provider" || !delivery.tenantId
      ? await renderer.render({
          ...common,
          db: deps.providerDb,
          scope: "provider",
          tenantId: null,
        })
      : await withTenantTx(deps.db, delivery.tenantId, (tx) =>
          renderer.render({
            ...common,
            db: tx,
            scope: "tenant",
            tenantId: delivery.tenantId,
          }),
        );
  return {
    message: rendered,
    headline: rendered.headline,
    attachments: rendered.attachments ?? [],
    brand,
  };
}

/**
 * Whether the channel's column switched the alert's event off after it was queued (the worker
 * leaves such channels out when it queues, plannedDeliveries): the delivery is skipped then. Tests
 * and summary reports are never held back; a channel without a column is the rule's business. A
 * provider recipient's row follows that recipient's column (and the floor), and goes with it.
 */
async function channelSwitchedOff(db: Database, delivery: ReportDelivery): Promise<boolean> {
  if (delivery.kind !== "event" || !delivery.event || delivery.payload.test === true) {
    return false;
  }
  if (!delivery.tenantId) {
    if (!delivery.providerRecipientId) {
      return false;
    }
    const [recipient] = await db
      .select({
        events: providerNotificationRecipients.events,
        kind: providerNotificationRecipients.kind,
        mandatory: providerNotificationRecipients.mandatory,
      })
      .from(providerNotificationRecipients)
      .where(eq(providerNotificationRecipients.id, delivery.providerRecipientId));
    return !recipient || !providerRecipientWants(recipient, delivery.event);
  }
  const recipient = delivery.recipient?.trim().toLowerCase();
  if (!recipient) {
    return false;
  }
  if (delivery.channel === "webhook") {
    const [hook] = await db
      .select({ events: webhooks.events })
      .from(webhooks)
      .where(and(eq(webhooks.tenantId, delivery.tenantId), eq(webhooks.id, recipient)));
    return hook !== undefined && !hook.events.includes(delivery.event);
  }
  if (delivery.channel === "email") {
    const [column] = await db
      .select({ events: tenantNotificationRecipients.events })
      .from(tenantNotificationRecipients)
      .where(
        and(
          eq(tenantNotificationRecipients.tenantId, delivery.tenantId),
          sql`lower(btrim(${tenantNotificationRecipients.email})) = ${recipient}`,
        ),
      );
    return column !== undefined && !column.events.includes(delivery.event);
  }
  return false;
}

/** The mail of a built message: brand sender, Reply-To, the inline logo if used, attachments. */
export function mailOf(
  to: string,
  message: RenderedMessage,
  brand: ReturnType<typeof mailBrandOf>,
  attachments: readonly MailAttachment[] = [],
): NotificationMessage {
  const files: MailAttachment[] = [];
  // The logo goes along only when the HTML refers to it (nothing is loaded from outside).
  if (brand.attachment?.cid && message.html.includes(`cid:${brand.attachment.cid}`)) {
    files.push(brand.attachment);
  }
  files.push(...attachments);
  return {
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(brand.from ? { from: brand.from } : {}),
    ...(brand.replyTo ? { replyTo: brand.replyTo } : {}),
    ...(files.length > 0 ? { attachments: files } : {}),
  };
}

/** Send one claimed row on its channel. */
export async function deliver(deps: DispatcherDeps, delivery: ReportDelivery): Promise<Outcome> {
  const now = (deps.now ?? (() => new Date()))();
  if (await channelSwitchedOff(deps.providerDb, delivery)) {
    return { status: "skipped", reason: "channel_off" };
  }
  const audience = await audienceOf(deps.providerDb, delivery);
  const built = await render(deps, delivery, audience);
  if ("skip" in built) {
    return { status: "skipped", reason: built.skip };
  }
  const { message, headline } = built;

  if (deps.demo && delivery.channel !== "in_app") {
    return { status: "skipped", reason: "demo_mode" };
  }

  if (delivery.channel === "email") {
    if (!delivery.recipient) return { status: "skipped", reason: "no_recipient" };
    const notifier = await deps.notifier();
    if (!notifier) {
      return { status: "retry", error: "mail_not_configured", reason: "mail_not_configured" };
    }
    const result = await notifier.send(
      mailOf(delivery.recipient, message, built.brand, built.attachments),
    );
    return result.ok
      ? { status: "sent" }
      : {
          status: "retry",
          error: result.error ?? "send_failed",
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.permanent ? { permanent: true } : {}),
        };
  }

  if (!delivery.tenantId) {
    // The provider's deliveries are e-mail only.
    return { status: "skipped", reason: "no_recipient" };
  }

  if (delivery.channel === "in_app") {
    await deps.providerDb.insert(notifications).values({
      tenantId: delivery.tenantId,
      level: "info",
      event: "report.ready",
      message: message.subject,
      details: {
        ruleId: delivery.ruleId,
        ruleName: delivery.ruleName,
        ...headline,
        ...delivery.payload,
      },
    });
    return { status: "sent" };
  }

  // Webhook: a signed delivery the worker's webhook dispatcher sends and logs.
  if (!delivery.recipient) return { status: "skipped", reason: "no_webhook" };
  const [hook] = await deps.providerDb
    .select({ id: webhooks.id, active: webhooks.active })
    .from(webhooks)
    .where(and(eq(webhooks.tenantId, delivery.tenantId), eq(webhooks.id, delivery.recipient)));
  if (!hook) return { status: "skipped", reason: "webhook_deleted" };
  if (!hook.active) return { status: "skipped", reason: "webhook_inactive" };
  const event = delivery.kind === "event" ? "report.alert" : "report.summary";
  const [queued] = await deps.providerDb
    .insert(webhookDeliveries)
    .values({
      tenantId: delivery.tenantId,
      webhookId: hook.id,
      event,
      payload: {
        id: randomUUID(),
        event,
        version: 1,
        createdAt: now.toISOString(),
        tenantId: delivery.tenantId,
        data: {
          rule: { id: delivery.ruleId, name: delivery.ruleName },
          subject: message.subject,
          text: message.text,
          ...delivery.payload,
          // An alert about a failed delivery never raises another one (the worker reads this).
          ...(isAlertAboutFailure(delivery) ? { deliveryFailure: true } : {}),
        },
      },
      status: "pending",
      nextAttemptAt: now,
    })
    .returning({ id: webhookDeliveries.id });
  return { status: "sent", webhookDeliveryId: queued?.id };
}

/** After an e-mail row's outcome: end or record the failure episode of its channel. */
async function afterMail(
  deps: DispatcherDeps,
  delivery: ReportDelivery,
  outcome: Outcome,
  final: string,
  now: Date,
): Promise<void> {
  if (delivery.channel !== "email") {
    return;
  }
  try {
    if (final === "sent") {
      await onMailDeliverySucceeded(deps.providerDb, deps.db, delivery);
    } else if (final === "failed" && outcome.status === "retry") {
      const result = await onMailDeliveryFailed(
        deps.providerDb,
        deps.db,
        delivery,
        { reason: outcome.reason ?? null, error: outcome.error },
        now,
      );
      deps.log?.(result === "alerted" ? "warn" : "info", "report delivery failed for good", {
        deliveryId: delivery.id,
        alert: result,
      });
    }
  } catch (error) {
    deps.log?.("error", "delivery failure could not be recorded", {
      deliveryId: delivery.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One pass: claim, send, record. Returns how many rows were handled. */
export async function dispatchOnce(deps: DispatcherDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const claimed = await claimDue(deps.providerDb, now);
  for (const delivery of claimed) {
    let outcome: Outcome;
    try {
      outcome = await deliver(deps, delivery);
    } catch (error) {
      outcome = { status: "retry", error: error instanceof Error ? error.message : String(error) };
    }
    const at = (deps.now ?? (() => new Date()))();
    const final = await recordOutcome(deps.providerDb, delivery, outcome, at);
    await afterMail(deps, delivery, outcome, final, at);
    deps.log?.(outcome.status === "retry" ? "warn" : "info", "report delivery", {
      deliveryId: delivery.id,
      channel: delivery.channel,
      status: final,
    });
  }
  return claimed.length;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

interface DigestGroup {
  tenantId: string | null;
  recipient: string;
  digest: "hourly" | "daily";
}

/** The groups of digest rows that are due: one per tenant (or the provider), address and window. */
async function dueDigestGroups(db: Database, now: Date): Promise<DigestGroup[]> {
  const result = await db.execute<{
    tenant_id: string | null;
    recipient: string;
    digest: string;
  }>(sql`
    SELECT tenant_id, lower(btrim(recipient)) AS recipient, digest
      FROM report_deliveries
     WHERE status = 'pending'
       AND digest IS NOT NULL
       AND next_attempt_at <= ${now}
       AND (lease_until IS NULL OR lease_until < ${now})
     GROUP BY tenant_id, lower(btrim(recipient)), digest
     ORDER BY min(next_attempt_at)
     LIMIT ${DIGEST_BATCH}`);
  return result.rows.map((row) => ({
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
    recipient: String(row.recipient),
    digest: row.digest === "hourly" ? "hourly" : "daily",
  }));
}

/** Lease a group's due rows (attempt counted); the rows another process leased stay out. */
async function leaseDigest(db: Database, group: DigestGroup, now: Date): Promise<ReportDelivery[]> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE report_deliveries
       SET attempts = attempts + 1,
           lease_until = ${new Date(now.getTime() + LEASE_SECONDS * 1000)},
           updated_at = ${now}
     WHERE id IN (
       SELECT id FROM report_deliveries
        WHERE status = 'pending'
          AND digest = ${group.digest}
          AND tenant_id IS NOT DISTINCT FROM ${group.tenantId}::uuid
          AND lower(btrim(recipient)) = ${group.recipient}
          AND next_attempt_at <= ${now}
          AND (lease_until IS NULL OR lease_until < ${now})
        FOR UPDATE SKIP LOCKED)
    RETURNING id`);
  const ids = result.rows.map((row) => String(row.id));
  if (ids.length === 0) return [];
  return db.select().from(reportDeliveries).where(inArray(reportDeliveries.id, ids));
}

function digestItem(delivery: ReportDelivery, tenantName: string | null): DigestItem {
  const payload = delivery.payload ?? {};
  const details = (payload.details ?? {}) as Record<string, unknown>;
  const level = payload.level === "error" || payload.level === "warning" ? payload.level : "info";
  const target =
    (typeof details.objectName === "string" && details.objectName.trim()) ||
    (typeof details.queue === "string" && details.queue.trim()) ||
    null;
  return {
    tenantName,
    event: typeof delivery.event === "string" ? delivery.event : String(payload.event ?? ""),
    level,
    occurredAt: typeof payload.occurredAt === "string" ? payload.occurredAt : null,
    target,
  };
}

/** Send one due digest; returns how many rows it covered. */
async function sendDigest(deps: DispatcherDeps, group: DigestGroup, now: Date): Promise<number> {
  const leased = await leaseDigest(deps.providerDb, group, now);
  if (leased.length === 0) return 0;
  const rows: ReportDelivery[] = [];
  for (const delivery of leased) {
    if (await channelSwitchedOff(deps.providerDb, delivery)) {
      await recordOutcome(
        deps.providerDb,
        delivery,
        { status: "skipped", reason: "channel_off" },
        now,
      );
    } else {
      rows.push(delivery);
    }
  }
  if (rows.length === 0) return leased.length;
  const first = rows[0] as ReportDelivery;
  const tenant = group.tenantId ? await tenantRow(deps.providerDb, group.tenantId) : null;
  const language: SupportedLanguage = group.tenantId
    ? (tenant?.language ?? first.language ?? defaultLanguage)
    : (first.language ?? defaultLanguage);
  const aboutNames = new Map<string, string>();
  for (const id of new Set(rows.flatMap((row) => (row.aboutTenantId ? [row.aboutTenantId] : [])))) {
    aboutNames.set(id, (await tenantRow(deps.providerDb, id))?.name ?? id);
  }
  const items = rows.map((row) =>
    digestItem(
      row,
      group.tenantId
        ? (tenant?.name ?? group.tenantId)
        : row.aboutTenantId
          ? (aboutNames.get(row.aboutTenantId) ?? null)
          : null,
    ),
  );
  const loaded = await effectiveBrand(deps.providerDb, group.tenantId);
  const brand = mailBrandOf(loaded, "cid");
  const windowStart = rows.reduce(
    (earliest, row) => (row.createdAt < earliest ? row.createdAt : earliest),
    first.createdAt,
  );
  const message = renderDigest({
    language,
    audience: group.tenantId ? "tenant" : "provider",
    tenantName: tenant?.name ?? null,
    window: group.digest,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    items,
    brand: brand.brand as MailBrand | null,
  });
  let outcome: Outcome;
  if (deps.demo) {
    outcome = { status: "skipped", reason: "demo_mode" };
  } else {
    const notifier = await deps.notifier();
    if (!notifier) {
      outcome = { status: "retry", error: "mail_not_configured", reason: "mail_not_configured" };
    } else {
      try {
        const result = await notifier.send(mailOf(group.recipient, message, brand));
        outcome = result.ok
          ? { status: "sent" }
          : {
              status: "retry",
              error: result.error ?? "send_failed",
              ...(result.reason ? { reason: result.reason } : {}),
              ...(result.permanent ? { permanent: true } : {}),
            };
      } catch (error) {
        outcome = {
          status: "retry",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  const digestGroup = randomUUID();
  // The group backs off as one: its retry follows the row tried most often.
  const attempts = Math.max(...rows.map((row) => row.attempts));
  let final: "sent" | "skipped" | "pending" | "failed" = "pending";
  for (const row of rows) {
    final = await recordOutcome(deps.providerDb, { ...row, attempts }, outcome, now);
  }
  await deps.providerDb
    .update(reportDeliveries)
    .set({ digestGroup })
    .where(
      inArray(
        reportDeliveries.id,
        rows.map((row) => row.id),
      ),
    );
  await afterMail(deps, first, outcome, final, now);
  deps.log?.(outcome.status === "retry" ? "warn" : "info", "report digest", {
    rows: rows.length,
    digest: group.digest,
    status: final,
  });
  return leased.length;
}

/** One pass over the due digests; returns how many rows were handled. */
export async function dispatchDigestsOnce(deps: DispatcherDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  let handled = 0;
  for (const group of await dueDigestGroups(deps.providerDb, now)) {
    try {
      handled += await sendDigest(deps, group, now);
    } catch (error) {
      deps.log?.("error", "report digest failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return handled;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** One tick: fan-out, digests, the due rows. Returns how many rows the last step handled. */
export async function dispatchTick(deps: DispatcherDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  try {
    while ((await fanOutOnce(deps.providerDb, now)) > 0) {}
  } catch (error) {
    deps.log?.("error", "report fan-out failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await dispatchDigestsOnce(deps);
  let handled = 0;
  let batch = 0;
  do {
    batch = await dispatchOnce(deps);
    handled += batch;
  } while (batch === CLAIM_BATCH);
  return handled;
}

/** Remove the fanned-out events after a week and the logos retired 30 days ago. */
export async function pruneOnce(deps: DispatcherDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  await pruneReportEvents(deps.providerDb, now);
  await pruneRetiredImages(deps.providerDb, now);
}

/** The dispatcher as a background service of the API process (server.ts). */
export function reportDispatcherService(deps: DispatcherDeps): BackgroundService {
  return {
    name: "report-dispatcher",
    async start() {
      let running = false;
      let lastPrune = 0;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          await dispatchTick(deps);
          if (Date.now() - lastPrune >= PRUNE_INTERVAL_MS) {
            lastPrune = Date.now();
            await pruneOnce(deps);
          }
        } catch (error) {
          deps.log?.("error", "report dispatcher pass failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          running = false;
        }
      };
      const timer = setInterval(() => void tick(), POLL_MS);
      timer.unref();
      void tick();
      return { close: () => clearInterval(timer) };
    },
  };
}
