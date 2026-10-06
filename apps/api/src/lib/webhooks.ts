import { randomBytes, randomUUID } from "node:crypto";
import { webhookDeliveries, webhooks } from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { type DbExecutor, type Transaction, withTenantTx } from "./tenant-context.js";

/**
 * Outbound webhooks: the events, the payload envelope and the emit helper
 * other features call when something happened (docs/ARCHITECTURE.md, "API").
 *
 * Emitting never talks to the network. It writes one `webhook_deliveries` row
 * per subscribed, active webhook of the tenant, inside the caller's
 * transaction when there is one, so an event is queued exactly when the change
 * that caused it commits. The worker (apps/worker/src/handlers/webhooks.ts)
 * picks the rows up, signs each body with the webhook's secret
 * (`X-Restow-Signature: sha256=<hex>`) and retries with backoff.
 *
 * The envelope and the retry budget are mirrored in the worker module; keep
 * both in step.
 */

/**
 * Events a webhook can subscribe to: exactly the events something raises.
 * An event joins this list together with its emitter, never before, so a
 * receiver never waits for a delivery that cannot come.
 */
export const WEBHOOK_EVENTS = ["job.failed", "job.completed", "verify.completed"] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * What a webhook's requests look like (mirrors the `webhook_format` enum):
 * `restow` is the signed JSON envelope below; `discord`, `slack` and `teams`
 * are chat messages rendered by the worker in the shape that service's
 * incoming webhooks accept, sent without a signature.
 */
export const WEBHOOK_FORMATS = ["restow", "discord", "slack", "teams"] as const;

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Chat formats carry no signature: the receiving services cannot check one. */
export function isSignedFormat(format: WebhookFormat): boolean {
  return format === "restow";
}

/** Sent by "Send test event"; not subscribable, delivered to the one webhook asked. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

export type WebhookDeliveryEvent = WebhookEvent | typeof WEBHOOK_TEST_EVENT;

/** Version of the envelope layout below; bumped only with a breaking change. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/** HTTP attempts per delivery before it is given up (the worker's retry schedule). */
export const WEBHOOK_MAX_ATTEMPTS = 8;

/** Finished deliveries are kept this long for the delivery log, then pruned by the worker. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** The JSON body every delivery carries. */
export interface WebhookEnvelope {
  /** Event id: identical across retries and redeliveries, so receivers can deduplicate. */
  id: string;
  event: WebhookDeliveryEvent;
  version: number;
  /** When the event happened (ISO 8601 UTC). */
  createdAt: string;
  tenantId: string;
  data: Record<string, unknown>;
}

export interface WebhookEventInput {
  tenantId: string;
  event: WebhookDeliveryEvent;
  /** Event details: ids, states, counts and timestamps; never secrets. */
  data: Record<string, unknown>;
  occurredAt?: Date;
}

export function buildWebhookEnvelope(
  input: WebhookEventInput,
  id: string = randomUUID(),
): WebhookEnvelope {
  return {
    id,
    event: input.event,
    version: WEBHOOK_PAYLOAD_VERSION,
    createdAt: (input.occurredAt ?? new Date()).toISOString(),
    tenantId: input.tenantId,
    data: input.data,
  };
}

/** A fresh signing secret (`whsec_` + 32 random bytes, base64url). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** Queue one delivery of `envelope` to one webhook, due immediately. Returns the row id. */
export async function queueWebhookDelivery(
  tx: Transaction,
  input: { tenantId: string; webhookId: string; envelope: WebhookEnvelope; now?: Date },
): Promise<string> {
  const now = input.now ?? new Date();
  const [row] = await tx
    .insert(webhookDeliveries)
    .values({
      tenantId: input.tenantId,
      webhookId: input.webhookId,
      event: input.envelope.event,
      payload: { ...input.envelope },
      status: "pending",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: webhookDeliveries.id });
  if (!row) {
    throw new Error("webhook delivery insert returned no row");
  }
  return row.id;
}

export interface EmittedWebhookEvent {
  eventId: string;
  /** One per subscribed, active webhook; empty when nobody listens. */
  deliveryIds: string[];
}

/**
 * Queue `event` for every active webhook of the tenant that subscribed to it.
 * Pass the open transaction of the change that caused the event, so both
 * commit together; with the pool a tenant-pinned transaction is opened.
 */
export async function emitWebhookEvent(
  db: DbExecutor,
  input: WebhookEventInput & { event: WebhookEvent },
): Promise<EmittedWebhookEvent> {
  const envelope = buildWebhookEnvelope(input);
  return withTenantTx(db, input.tenantId, async (tx) => {
    const subscribed = await tx
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.tenantId, input.tenantId),
          eq(webhooks.active, true),
          sql`${input.event} = ANY(${webhooks.events})`,
        ),
      );
    const now = new Date();
    const deliveryIds: string[] = [];
    for (const webhook of subscribed) {
      deliveryIds.push(
        await queueWebhookDelivery(tx, {
          tenantId: input.tenantId,
          webhookId: webhook.id,
          envelope,
          now,
        }),
      );
    }
    return { eventId: envelope.id, deliveryIds };
  });
}
