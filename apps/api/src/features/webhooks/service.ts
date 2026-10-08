import { type Database, type WebhookDeliveryStatus, webhookDeliveries, webhooks } from "@restow/db";
import { type SQL, and, count, desc, eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { deleteSecret, replaceSecret, storeSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TEST_EVENT,
  type WebhookDeliveryEvent,
  type WebhookEnvelope,
  type WebhookEvent,
  type WebhookFormat,
  buildWebhookEnvelope,
  generateWebhookSecret,
  queueWebhookDelivery,
} from "../../lib/webhooks.js";
import { ProblemError } from "../../problem.js";
import { toCsv } from "../stats/csv.js";
import { decodeDeliveryCursor, encodeDeliveryCursor } from "./cursor.js";
import { type DeliveryErrorDto, parseDeliveryError } from "./delivery-error.js";
import type { CreateWebhookInput, DeliveriesQuery, UpdateWebhookInput } from "./schemas.js";

/**
 * Webhook subscriptions of a tenant, their signing secrets and the delivery
 * log. Secrets live sealed in the secret store and are returned only when
 * created or rotated. Everything runs in the tenant's RLS context and every
 * change is audited; webhook URLs are audited by origin only, because some
 * receivers (chat incoming webhooks) carry their token in the path or query.
 */

export const WEBHOOK_AUDIT_ACTIONS = {
  created: "webhook.created",
  updated: "webhook.updated",
  deleted: "webhook.deleted",
  secretRotated: "webhook.secret.rotated",
  tested: "webhook.tested",
  redelivered: "webhook.delivery.redelivered",
} as const;

/** Webhooks allowed per tenant. */
export const MAX_WEBHOOKS_PER_TENANT = 20;

const RECENT_WINDOW = sql`interval '24 hours'`;

/** Who acts: a signed-in person or an integration key (`api-key:<id>`). */
export interface WebhookActor {
  userId: string | null;
  label: string;
  ip: string | null;
}

export interface LastDeliveryDto {
  id: string;
  event: string;
  status: WebhookDeliveryStatus;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WebhookStatsDto {
  pending: number;
  failedLast24h: number;
  deliveredLast24h: number;
  lastDelivery: LastDeliveryDto | null;
}

export interface WebhookDto {
  id: string;
  name: string | null;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  /** `restow` (signed JSON) or the chat service the messages are shaped for. */
  format: WebhookFormat;
  /** Whether a signing secret is stored; only the `restow` format uses it. */
  secretConfigured: boolean;
  createdAt: string;
  updatedAt: string;
  stats: WebhookStatsDto;
}

/** Returned on creation and rotation only: the signing secret, shown this one time. */
export interface WebhookWithSecretDto extends WebhookDto {
  secret: string;
}

export interface DeliveryDto {
  id: string;
  webhookId: string;
  event: string;
  /** The envelope's event id (shared by retries and redeliveries). */
  eventId: string | null;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  lastError: DeliveryErrorDto | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryDetailDto extends DeliveryDto {
  payload: Record<string, unknown>;
}

export interface DeliveriesPage {
  items: DeliveryDto[];
  next: string | null;
}

type WebhookRow = typeof webhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** Scheme, host and port of a URL: what the audit log records of a target. */
export function urlOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

export const EMPTY_STATS: WebhookStatsDto = {
  pending: 0,
  failedLast24h: 0,
  deliveredLast24h: 0,
  lastDelivery: null,
};

export function toWebhookDto(row: WebhookRow, stats: WebhookStatsDto = EMPTY_STATS): WebhookDto {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: WEBHOOK_EVENTS.filter((event) => row.events.includes(event)),
    active: row.active,
    format: row.format,
    secretConfigured: row.secretRef !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stats,
  };
}

function eventIdOf(payload: Record<string, unknown>): string | null {
  return typeof payload.id === "string" ? payload.id : null;
}

export function toDeliveryDto(row: DeliveryRow): DeliveryDto {
  return {
    id: row.id,
    webhookId: row.webhookId,
    event: row.event,
    eventId: eventIdOf(row.payload),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    lastError: parseDeliveryError(row.lastError),
    nextAttemptAt: row.status === "pending" ? iso(row.nextAttemptAt) : null,
    deliveredAt: iso(row.deliveredAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Which fields a patch changes, for the audit entry (the URL by origin only). */
export function describeChanges(
  before: WebhookRow,
  patch: UpdateWebhookInput,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined && patch.name !== before.name) {
    changes.name = patch.name;
  }
  if (patch.url !== undefined && patch.url !== before.url) {
    changes.urlOrigin = urlOrigin(patch.url);
  }
  if (patch.events !== undefined) {
    const same =
      patch.events.length === before.events.length &&
      patch.events.every((event) => before.events.includes(event));
    if (!same) {
      changes.events = patch.events;
    }
  }
  if (patch.active !== undefined && patch.active !== before.active) {
    changes.active = patch.active;
  }
  if (patch.format !== undefined && patch.format !== before.format) {
    changes.format = patch.format;
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function findWebhook(tx: Transaction, tenantId: string, id: string): Promise<WebhookRow> {
  const [row] = await tx
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, id)))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Webhook not found");
  }
  return row;
}

async function loadStats(
  tx: Transaction,
  tenantId: string,
  webhookId?: string,
): Promise<Map<string, WebhookStatsDto>> {
  const scope: SQL | undefined = webhookId
    ? and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.webhookId, webhookId))
    : eq(webhookDeliveries.tenantId, tenantId);
  const recent = sql`${webhookDeliveries.createdAt} > now() - ${RECENT_WINDOW}`;
  const counts = await tx
    .select({
      webhookId: webhookDeliveries.webhookId,
      pending: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'pending')::int`,
      failed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'failed' and ${recent})::int`,
      delivered: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'delivered' and ${recent})::int`,
    })
    .from(webhookDeliveries)
    .where(scope)
    .groupBy(webhookDeliveries.webhookId);
  const latest = await tx
    .selectDistinctOn([webhookDeliveries.webhookId], {
      webhookId: webhookDeliveries.webhookId,
      id: webhookDeliveries.id,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      createdAt: webhookDeliveries.createdAt,
      deliveredAt: webhookDeliveries.deliveredAt,
    })
    .from(webhookDeliveries)
    .where(scope)
    .orderBy(
      webhookDeliveries.webhookId,
      desc(webhookDeliveries.createdAt),
      desc(webhookDeliveries.id),
    );

  const stats = new Map<string, WebhookStatsDto>();
  for (const row of counts) {
    stats.set(row.webhookId, {
      pending: Number(row.pending),
      failedLast24h: Number(row.failed),
      deliveredLast24h: Number(row.delivered),
      lastDelivery: null,
    });
  }
  for (const row of latest) {
    const entry = stats.get(row.webhookId) ?? { ...EMPTY_STATS };
    entry.lastDelivery = {
      id: row.id,
      event: row.event,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      deliveredAt: iso(row.deliveredAt),
    };
    stats.set(row.webhookId, entry);
  }
  return stats;
}

async function webhookDto(tx: Transaction, row: WebhookRow): Promise<WebhookDto> {
  const stats = await loadStats(tx, row.tenantId, row.id);
  return toWebhookDto(row, stats.get(row.id));
}

function auditEvent(
  tenantId: string,
  actor: WebhookActor,
  action: string,
  target: string,
  details: Record<string, unknown>,
) {
  return {
    tenantId,
    actor: actor.label,
    actorUserId: actor.userId,
    action,
    target,
    targetType: "webhook",
    ip: actor.ip,
    details,
  };
}

function webhookPaused(): ProblemError {
  return new ProblemError(409, "Webhook paused", {
    type: "urn:restow:problem:webhook-paused",
    detail: "The webhook is paused. Activate it before sending deliveries.",
  });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function listWebhooks(db: Database, tenantId: string): Promise<WebhookDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(webhooks)
      .where(eq(webhooks.tenantId, tenantId))
      .orderBy(desc(webhooks.createdAt), desc(webhooks.id));
    const stats = await loadStats(tx, tenantId);
    return rows.map((row) => toWebhookDto(row, stats.get(row.id)));
  });
}

export async function getWebhook(db: Database, tenantId: string, id: string): Promise<WebhookDto> {
  return withTenantTx(db, tenantId, async (tx) =>
    webhookDto(tx, await findWebhook(tx, tenantId, id)),
  );
}

export async function createWebhook(
  db: Database,
  tenantId: string,
  input: CreateWebhookInput,
  actor: WebhookActor,
): Promise<WebhookWithSecretDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [existing] = await tx
      .select({ n: count() })
      .from(webhooks)
      .where(eq(webhooks.tenantId, tenantId));
    if (Number(existing?.n ?? 0) >= MAX_WEBHOOKS_PER_TENANT) {
      throw new ProblemError(409, "Webhook limit reached", {
        type: "urn:restow:problem:webhook-limit",
        detail: `A tenant can have at most ${MAX_WEBHOOKS_PER_TENANT} webhooks.`,
        extensions: { limit: MAX_WEBHOOKS_PER_TENANT },
      });
    }
    // Every webhook gets a secret, also one in a chat format that sends no signature: switched
    // to `restow` later, it signs from the first delivery on (the web UI then rotates the secret
    // to show one), and the answer keeps one shape for every format.
    const secret = generateWebhookSecret();
    const ref = await storeSecret(tx, {
      tenantId,
      kind: "webhook_signing_secret",
      plaintext: secret,
    });
    const [row] = await tx
      .insert(webhooks)
      .values({
        tenantId,
        name: input.name,
        url: input.url,
        events: input.events,
        active: input.active,
        format: input.format,
        secretRef: ref.id,
      })
      .returning();
    if (!row) {
      throw new Error("webhook insert returned no row");
    }
    await audit(
      tx,
      auditEvent(tenantId, actor, WEBHOOK_AUDIT_ACTIONS.created, row.id, {
        name: row.name,
        urlOrigin: urlOrigin(row.url),
        events: input.events,
        active: row.active,
        format: row.format,
      }),
    );
    return { ...toWebhookDto(row), secret };
  });
}

export async function updateWebhook(
  db: Database,
  tenantId: string,
  id: string,
  patch: UpdateWebhookInput,
  actor: WebhookActor,
): Promise<WebhookDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const before = await findWebhook(tx, tenantId, id);
    const changes = describeChanges(before, patch);
    if (Object.keys(changes).length === 0) {
      return webhookDto(tx, before);
    }
    const [row] = await tx
      .update(webhooks)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.events !== undefined ? { events: patch.events } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.format !== undefined ? { format: patch.format } : {}),
      })
      .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, id)))
      .returning();
    if (!row) {
      throw new ProblemError(404, "Webhook not found");
    }
    if (changes.active === false) {
      // A paused webhook receives nothing: queued retries end here, visibly.
      await tx
        .update(webhookDeliveries)
        .set({ status: "failed", lastError: "webhook_disabled", nextAttemptAt: null })
        .where(
          and(
            eq(webhookDeliveries.tenantId, tenantId),
            eq(webhookDeliveries.webhookId, id),
            eq(webhookDeliveries.status, "pending"),
          ),
        );
    }
    await audit(tx, auditEvent(tenantId, actor, WEBHOOK_AUDIT_ACTIONS.updated, id, changes));
    return webhookDto(tx, row);
  });
}

export async function deleteWebhook(
  db: Database,
  tenantId: string,
  id: string,
  actor: WebhookActor,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const row = await findWebhook(tx, tenantId, id);
    // Deliveries go with the webhook (foreign key cascade).
    await tx.delete(webhooks).where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, id)));
    if (row.secretRef) {
      await deleteSecret(tx, { id: row.secretRef, tenantId });
    }
    await audit(
      tx,
      auditEvent(tenantId, actor, WEBHOOK_AUDIT_ACTIONS.deleted, id, {
        name: row.name,
        urlOrigin: urlOrigin(row.url),
      }),
    );
  });
}

/** Replace the signing secret; the old one stops verifying with the next attempt. */
export async function rotateWebhookSecret(
  db: Database,
  tenantId: string,
  id: string,
  actor: WebhookActor,
): Promise<WebhookWithSecretDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    let row = await findWebhook(tx, tenantId, id);
    const secret = generateWebhookSecret();
    if (row.secretRef) {
      await replaceSecret(tx, { id: row.secretRef, tenantId }, secret);
    } else {
      const ref = await storeSecret(tx, {
        tenantId,
        kind: "webhook_signing_secret",
        plaintext: secret,
      });
      const [updated] = await tx
        .update(webhooks)
        .set({ secretRef: ref.id })
        .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, id)))
        .returning();
      row = updated ?? row;
    }
    await audit(tx, auditEvent(tenantId, actor, WEBHOOK_AUDIT_ACTIONS.secretRotated, id, {}));
    return { ...(await webhookDto(tx, row)), secret };
  });
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

async function findDelivery(
  tx: Transaction,
  tenantId: string,
  webhookId: string,
  deliveryId: string,
): Promise<DeliveryRow> {
  const [row] = await tx
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.tenantId, tenantId),
        eq(webhookDeliveries.webhookId, webhookId),
        eq(webhookDeliveries.id, deliveryId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Delivery not found");
  }
  return row;
}

async function queueAndLoad(
  tx: Transaction,
  tenantId: string,
  webhookId: string,
  envelope: WebhookEnvelope,
): Promise<DeliveryDto> {
  const deliveryId = await queueWebhookDelivery(tx, { tenantId, webhookId, envelope });
  return toDeliveryDto(await findDelivery(tx, tenantId, webhookId, deliveryId));
}

/** Queue a `webhook.test` delivery to one webhook, regardless of its subscriptions. */
export async function sendTestEvent(
  db: Database,
  tenantId: string,
  id: string,
  actor: WebhookActor,
): Promise<DeliveryDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const row = await findWebhook(tx, tenantId, id);
    if (!row.active) {
      throw webhookPaused();
    }
    const envelope = buildWebhookEnvelope({
      tenantId,
      event: WEBHOOK_TEST_EVENT,
      data: { webhookId: row.id, webhookName: row.name, test: true },
    });
    const delivery = await queueAndLoad(tx, tenantId, id, envelope);
    await audit(
      tx,
      auditEvent(tenantId, actor, WEBHOOK_AUDIT_ACTIONS.tested, id, { deliveryId: delivery.id }),
    );
    return delivery;
  });
}

export async function listDeliveries(
  db: Database,
  tenantId: string,
  webhookId: string,
  query: DeliveriesQuery,
): Promise<DeliveriesPage> {
  const cursor = query.cursor ? decodeDeliveryCursor(query.cursor) : null;
  return withTenantTx(db, tenantId, async (tx) => {
    await findWebhook(tx, tenantId, webhookId);
    const conditions: SQL[] = [
      eq(webhookDeliveries.tenantId, tenantId),
      eq(webhookDeliveries.webhookId, webhookId),
    ];
    if (query.status) {
      conditions.push(eq(webhookDeliveries.status, query.status));
    }
    if (cursor) {
      conditions.push(
        sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await tx
      .select({
        row: webhookDeliveries,
        // Full precision for the cursor; a JS Date would drop the microseconds.
        cursorAt: sql<string>`to_char(${webhookDeliveries.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ row }) => toDeliveryDto(row)),
      next:
        rows.length > query.limit && last
          ? encodeDeliveryCursor({ createdAt: last.cursorAt, id: last.row.id })
          : null,
    };
  });
}

export async function getDelivery(
  db: Database,
  tenantId: string,
  webhookId: string,
  deliveryId: string,
): Promise<DeliveryDetailDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const row = await findDelivery(tx, tenantId, webhookId, deliveryId);
    return { ...toDeliveryDto(row), payload: row.payload };
  });
}

/**
 * Send a finished delivery again as a new delivery with the same envelope
 * (same event id), so the log keeps the original attempts and receivers can
 * still deduplicate.
 */
export async function redeliver(
  db: Database,
  tenantId: string,
  webhookId: string,
  deliveryId: string,
  actor: WebhookActor,
): Promise<DeliveryDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const webhook = await findWebhook(tx, tenantId, webhookId);
    if (!webhook.active) {
      throw webhookPaused();
    }
    const original = await findDelivery(tx, tenantId, webhookId, deliveryId);
    if (original.status === "pending") {
      throw new ProblemError(409, "Delivery still queued", {
        type: "urn:restow:problem:delivery-pending",
        detail: "This delivery is still being attempted; wait until it has finished.",
      });
    }
    const envelope = original.payload as unknown as WebhookEnvelope;
    const delivery = await queueAndLoad(tx, tenantId, webhookId, envelope);
    await audit(
      tx,
      auditEvent(tenantId, actor, WEBHOOK_AUDIT_ACTIONS.redelivered, webhookId, {
        deliveryId: delivery.id,
        originalDeliveryId: original.id,
        event: original.event,
      }),
    );
    return delivery;
  });
}

/** The subscribable events, for integrations discovering the contract. */
export function listEvents(): { items: readonly WebhookEvent[]; test: WebhookDeliveryEvent } {
  return { items: WEBHOOK_EVENTS, test: WEBHOOK_TEST_EVENT };
}

/** More deliveries than this are not exported at once (the log keeps 30 days anyway). */
export const MAX_DELIVERY_EXPORT = 10_000;

/** A webhook's delivery log as CSV, with the list's status filter, newest first. */
export async function deliveriesCsv(
  db: Database,
  tenantId: string,
  webhookId: string,
  status: DeliveriesQuery["status"],
): Promise<string> {
  const items: DeliveryDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await listDeliveries(db, tenantId, webhookId, { status, limit: 200, cursor });
    items.push(...page.items);
    cursor = page.next ?? undefined;
  } while (cursor && items.length < MAX_DELIVERY_EXPORT);
  return toCsv(
    [
      "createdAt",
      "event",
      "eventId",
      "status",
      "attempts",
      "deliveredAt",
      "error",
      "httpStatus",
      "detail",
    ],
    items
      .slice(0, MAX_DELIVERY_EXPORT)
      .map((item) => [
        item.createdAt,
        item.event,
        item.eventId,
        item.status,
        item.attempts,
        item.deliveredAt,
        item.lastError?.code ?? null,
        item.lastError?.httpStatus ?? null,
        item.lastError?.detail ?? null,
      ]),
  );
}
