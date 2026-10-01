import { randomUUID } from "node:crypto";
import { MAX_REPORT_ATTEMPTS, nextAttemptAfter } from "@restow/core";
import {
  type Database,
  type ReportDelivery,
  notifications,
  reportDeliveries,
  tenants,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { type SupportedLanguage, defaultLanguage } from "@restow/i18n";
import { and, eq, sql } from "drizzle-orm";
import type { BackgroundService } from "../../extensions.js";
import { featureHook } from "../../extensions.js";
import { featureEnabled } from "../../lib/features.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { Notifier } from "../../notify.js";
import { type RenderedMessage, renderAlert } from "./render.js";
import "./hooks.js";

/**
 * The report outbox dispatcher (docs/ARCHITECTURE.md, Reports and
 * notifications): a loop in the API process that claims due rows of
 * `report_deliveries` across tenants (FOR UPDATE SKIP LOCKED plus a lease,
 * so several API processes never send the same row twice and a crashed one
 * only delays it), renders them in the rule's or tenant's language and sends
 * them: e-mail through the installation's mail transport (Settings), the bell
 * as an in-app notification, a webhook as a signed delivery the worker's
 * webhook dispatcher sends. Failures are retried with backoff and then given
 * up; every outcome stays in the delivery log.
 */

const CLAIM_BATCH = 20;
const LEASE_SECONDS = 120;
const POLL_MS = 15_000;

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

type Outcome =
  | { status: "sent" }
  | { status: "skipped"; reason: string }
  | { status: "retry"; error: string };

/** Claim the due rows (attempt counted, lease set). */
export async function claimDue(db: Database, now: Date): Promise<ReportDelivery[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    UPDATE report_deliveries
       SET attempts = attempts + 1,
           lease_until = ${new Date(now.getTime() + LEASE_SECONDS * 1000)},
           updated_at = ${now}
     WHERE id IN (
       SELECT id FROM report_deliveries
        WHERE status = 'pending'
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

async function tenantOf(db: Database, tenantId: string) {
  const [row] = await db
    .select({ name: tenants.name, language: tenants.language })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ?? { name: tenantId, language: null };
}

/** Record what happened to a claimed row. */
export async function recordOutcome(
  db: Database,
  delivery: ReportDelivery,
  outcome: Outcome,
  now: Date,
): Promise<void> {
  if (outcome.status === "sent") {
    await db
      .update(reportDeliveries)
      .set({ status: "sent", sentAt: now, leaseUntil: null, lastError: null, updatedAt: now })
      .where(eq(reportDeliveries.id, delivery.id));
    return;
  }
  if (outcome.status === "skipped") {
    await db
      .update(reportDeliveries)
      .set({ status: "skipped", leaseUntil: null, lastError: outcome.reason, updatedAt: now })
      .where(eq(reportDeliveries.id, delivery.id));
    return;
  }
  const next =
    delivery.attempts >= MAX_REPORT_ATTEMPTS ? null : nextAttemptAfter(delivery.attempts, now);
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
}

/** Build the message of a row, or say why it cannot be built. */
async function render(
  deps: DispatcherDeps,
  delivery: ReportDelivery,
  tenant: { name: string; language: "de" | "en" | null },
): Promise<{ message: RenderedMessage; headline: Record<string, unknown> } | { skip: string }> {
  const language: SupportedLanguage = delivery.language ?? tenant.language ?? defaultLanguage;
  const payload = delivery.payload ?? {};
  const test = payload.test === true;
  if (delivery.kind === "event") {
    return {
      message: renderAlert({
        language,
        tenantName: tenant.name,
        ruleName: delivery.ruleName,
        payload,
        test,
      }),
      headline: { event: delivery.event },
    };
  }
  const renderer = featureHook("reportSummary");
  if (!renderer || !(await featureEnabled(deps.providerDb, "reports.timed"))) {
    return { skip: "not_available" };
  }
  const rendered = await withTenantTx(deps.db, delivery.tenantId, (tx) =>
    renderer.render({
      db: tx,
      tenantId: delivery.tenantId,
      tenantName: tenant.name,
      ruleName: delivery.ruleName,
      language,
      payload,
      test,
    }),
  );
  return { message: rendered, headline: rendered.headline };
}

/** Send one claimed row on its channel. */
export async function deliver(deps: DispatcherDeps, delivery: ReportDelivery): Promise<Outcome> {
  const now = (deps.now ?? (() => new Date()))();
  const tenant = await tenantOf(deps.providerDb, delivery.tenantId);
  const built = await render(deps, delivery, tenant);
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
    if (!notifier) return { status: "retry", error: "mail_not_configured" };
    const result = await notifier.send({ to: delivery.recipient, ...message });
    return result.ok
      ? { status: "sent" }
      : { status: "retry", error: result.error ?? "send_failed" };
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
  await deps.providerDb.insert(webhookDeliveries).values({
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
      },
    },
    status: "pending",
    nextAttemptAt: now,
  });
  return { status: "sent" };
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
    await recordOutcome(deps.providerDb, delivery, outcome, (deps.now ?? (() => new Date()))());
    deps.log?.(outcome.status === "retry" ? "warn" : "info", "report delivery", {
      deliveryId: delivery.id,
      channel: delivery.channel,
      status: outcome.status,
    });
  }
  return claimed.length;
}

/** The dispatcher as a background service of the API process (server.ts). */
export function reportDispatcherService(deps: DispatcherDeps): BackgroundService {
  return {
    name: "report-dispatcher",
    async start() {
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          // Drain what is due, then wait for the next poll.
          while ((await dispatchOnce(deps)) === CLAIM_BATCH) {}
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
