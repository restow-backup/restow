import { randomUUID } from "node:crypto";
import {
  type Database,
  type ProviderWebhook,
  providers,
  providerWebhooks,
  type WebhookDelivery,
  webhookDeliveries,
} from "@restow/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type DeliveryErrorDto,
  parseDeliveryError,
} from "../../../../apps/api/src/features/webhooks/delivery-error.js";
import { webhookUrlSchema } from "../../../../apps/api/src/features/webhooks/schemas.js";
import { urlOrigin } from "../../../../apps/api/src/features/webhooks/service.js";
import { audit as appendAudit } from "../../../../apps/api/src/lib/audit.js";
import { deleteSecret, replaceSecret, storeSecret } from "../../../../apps/api/src/lib/secrets.js";
import type { DbExecutor } from "../../../../apps/api/src/lib/tenant-context.js";
import {
  generateWebhookSecret,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_TEST_EVENT,
} from "../../../../apps/api/src/lib/webhooks.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";

/**
 * The provider's own webhooks (0.6.0, Service Provider; docs/ARCHITECTURE.md, "Webhooks des
 * Providers"): events of the installation, not of one tenant, for the provider's billing and PSA
 * tools. A tenant's webhooks stay the tenant's (`webhooks`); these live in `provider_webhooks`,
 * their secrets at installation level, their deliveries in the same `webhook_deliveries` outbox
 * with a null `tenant_id` and `provider_webhook_id` set, delivered, signed and retried by the
 * worker's dispatcher exactly like a tenant webhook's (apps/worker handlers/webhooks.ts).
 *
 * Always the signed `restow` envelope: `{id, event, version, createdAt, scope: "provider", data}`
 * with `X-Restow-Signature: sha256=<HMAC-SHA-256 of the body under the secret>`. The first event
 * is `billing.period_closed`, queued in the transaction of the monthly close
 * (../billing-close/service.ts); `webhook.test` reaches only the webhook asked.
 *
 * Every change is audited in the installation chain (`provider_webhook.*`), the URL by origin
 * only (a receiver may carry its token in the path).
 */

export const PROVIDER_WEBHOOK_BILLING_CLOSED = "billing.period_closed";

/** Events a provider webhook can subscribe to. */
export const PROVIDER_WEBHOOK_EVENTS = [PROVIDER_WEBHOOK_BILLING_CLOSED] as const;
export type ProviderWebhookEvent = (typeof PROVIDER_WEBHOOK_EVENTS)[number];

export const PROVIDER_WEBHOOK_AUDIT_ACTIONS = {
  created: "provider_webhook.created",
  updated: "provider_webhook.updated",
  deleted: "provider_webhook.deleted",
  tested: "provider_webhook.tested",
  secretRotated: "provider_webhook.secret_rotated",
} as const;

export const MAX_PROVIDER_WEBHOOKS = 20;

/** Deliveries a webhook's log shows. */
export const PROVIDER_DELIVERY_LOG_LIMIT = 50;

/** Who changes a provider webhook: a member of the provider team or a provider API key. */
export interface ProviderWebhookActor {
  label: string;
  userId: string | null;
  ip: string | null;
  /** The API key, when one acted. */
  keyId?: string | null;
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const nameSchema = z
  .string()
  .trim()
  .max(100)
  .nullable()
  .transform((value) => (value && value.length > 0 ? value : null));

const eventsSchema = z
  .array(z.enum(PROVIDER_WEBHOOK_EVENTS))
  .max(PROVIDER_WEBHOOK_EVENTS.length * 2)
  .transform((events) => PROVIDER_WEBHOOK_EVENTS.filter((event) => events.includes(event)));

export const createProviderWebhookSchema = z
  .object({
    name: nameSchema.optional().transform((value) => value ?? null),
    url: webhookUrlSchema,
    // Omitted: every event.
    events: eventsSchema.optional(),
    active: z.boolean().default(true),
  })
  .strict();
export type CreateProviderWebhookInput = z.infer<typeof createProviderWebhookSchema>;

export const updateProviderWebhookSchema = z
  .object({
    name: nameSchema.optional(),
    url: webhookUrlSchema.optional(),
    events: eventsSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Nothing to update.",
  });
export type UpdateProviderWebhookInput = z.infer<typeof updateProviderWebhookSchema>;

export const providerWebhookParamSchema = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface ProviderWebhookDeliveryDto {
  id: string;
  event: string;
  /** The envelope's event id, shared by the retries. */
  eventId: string | null;
  status: WebhookDelivery["status"];
  attempts: number;
  maxAttempts: number;
  lastError: DeliveryErrorDto | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ProviderWebhookDto {
  id: string;
  name: string | null;
  url: string;
  events: ProviderWebhookEvent[];
  active: boolean;
  /** Since when attempts fail in a row (null: the last attempt was delivered or none failed). */
  failingSince: string | null;
  consecutiveFailures: number;
  lastFailure: DeliveryErrorDto | null;
  /** Deliveries still to be sent (pending). */
  pending: number;
  lastDelivery: ProviderWebhookDeliveryDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderWebhookWithSecretDto extends ProviderWebhookDto {
  /** The signing secret: only in the answer of the creation and of a rotation. */
  secret: string;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function knownEvents(events: readonly string[]): ProviderWebhookEvent[] {
  return PROVIDER_WEBHOOK_EVENTS.filter((event) => events.includes(event));
}

export function toDeliveryDto(row: WebhookDelivery): ProviderWebhookDeliveryDto {
  const payload = row.payload ?? {};
  return {
    id: row.id,
    event: row.event,
    eventId: typeof payload.id === "string" ? payload.id : null,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    lastError: parseDeliveryError(row.lastError),
    nextAttemptAt: row.status === "pending" ? iso(row.nextAttemptAt) : null,
    deliveredAt: iso(row.deliveredAt),
    createdAt: row.createdAt.toISOString(),
  };
}

async function toDto(db: DbExecutor, row: ProviderWebhook): Promise<ProviderWebhookDto> {
  const [counts] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'pending')::int`,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.providerWebhookId, row.id));
  const [last] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.providerWebhookId, row.id))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(1);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: knownEvents(row.events),
    active: row.active,
    failingSince: iso(row.failingSince),
    consecutiveFailures: row.consecutiveFailures,
    lastFailure: parseDeliveryError(row.lastFailure),
    pending: Number(counts?.pending ?? 0),
    lastDelivery: last ? toDeliveryDto(last) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/** The JSON body of a provider webhook's delivery. */
export interface ProviderWebhookEnvelope {
  /** Event id: the same across retries, so a receiver can deduplicate. */
  id: string;
  event: ProviderWebhookEvent | typeof WEBHOOK_TEST_EVENT;
  version: number;
  createdAt: string;
  /** Always `provider`: an event of the installation, not of a tenant. */
  scope: "provider";
  data: Record<string, unknown>;
}

export function buildProviderEnvelope(
  event: ProviderWebhookEnvelope["event"],
  data: Record<string, unknown>,
  now: Date,
  id: string = randomUUID(),
): ProviderWebhookEnvelope {
  return {
    id,
    event,
    version: WEBHOOK_PAYLOAD_VERSION,
    createdAt: now.toISOString(),
    scope: "provider",
    data,
  };
}

/**
 * Queue `event` for every active provider webhook that subscribed to it (or, for a test, for the
 * one webhook named), in the caller's transaction: the event goes out exactly when what caused it
 * commits. Returns the delivery ids.
 */
export async function queueProviderWebhookEvent(
  tx: DbExecutor,
  input: {
    event: ProviderWebhookEnvelope["event"];
    data: Record<string, unknown>;
    now: Date;
    /** Only this webhook, subscribed or not (the test event). */
    webhookId?: string;
  },
): Promise<string[]> {
  const targets = await tx
    .select({ id: providerWebhooks.id })
    .from(providerWebhooks)
    .where(
      input.webhookId
        ? eq(providerWebhooks.id, input.webhookId)
        : and(
            eq(providerWebhooks.active, true),
            sql`${input.event} = ANY(${providerWebhooks.events})`,
          ),
    );
  if (targets.length === 0) {
    return [];
  }
  const envelope = buildProviderEnvelope(input.event, input.data, input.now);
  const rows = await tx
    .insert(webhookDeliveries)
    .values(
      targets.map((target) => ({
        tenantId: null,
        webhookId: null,
        providerWebhookId: target.id,
        event: envelope.event,
        payload: { ...envelope },
        status: "pending" as const,
        nextAttemptAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

type Deps = { providerDb: Database; audit?: typeof appendAudit };

function notFound(): ProblemError {
  return new ProblemError(404, "Webhook not found");
}

async function find(tx: DbExecutor, id: string): Promise<ProviderWebhook> {
  const [row] = await tx
    .select()
    .from(providerWebhooks)
    .where(eq(providerWebhooks.id, id))
    .limit(1);
  if (!row) {
    throw notFound();
  }
  return row;
}

async function record(
  deps: Deps,
  tx: DbExecutor,
  actor: ProviderWebhookActor,
  action: string,
  id: string,
  details: Record<string, unknown>,
): Promise<void> {
  await (deps.audit ?? appendAudit)(tx, {
    tenantId: null,
    actor: actor.label,
    actorUserId: actor.userId,
    action,
    target: id,
    targetType: "provider_webhook",
    ip: actor.ip,
    details: { ...(actor.keyId ? { keyId: actor.keyId } : {}), ...details },
  });
}

export async function listProviderWebhooks(
  providerDb: Database,
): Promise<{ items: ProviderWebhookDto[]; events: ProviderWebhookEvent[] }> {
  const rows = await providerDb
    .select()
    .from(providerWebhooks)
    .orderBy(asc(providerWebhooks.createdAt), asc(providerWebhooks.id));
  const items: ProviderWebhookDto[] = [];
  for (const row of rows) {
    items.push(await toDto(providerDb, row));
  }
  return { items, events: [...PROVIDER_WEBHOOK_EVENTS] };
}

export async function getProviderWebhook(
  providerDb: Database,
  id: string,
): Promise<ProviderWebhookDto> {
  return toDto(providerDb, await find(providerDb, id));
}

export async function createProviderWebhook(
  deps: Deps,
  input: CreateProviderWebhookInput,
  actor: ProviderWebhookActor,
): Promise<ProviderWebhookWithSecretDto> {
  return deps.providerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('restow:provider-webhooks'))`);
    const [counted] = await tx.select({ count: sql<number>`count(*)::int` }).from(providerWebhooks);
    if ((counted?.count ?? 0) >= MAX_PROVIDER_WEBHOOKS) {
      throw new ProblemError(409, "Too many webhooks", {
        detail: `The provider can have at most ${MAX_PROVIDER_WEBHOOKS} webhooks.`,
      });
    }
    const [provider] = await tx.select({ id: providers.id }).from(providers).limit(1);
    if (!provider) {
      throw new ProblemError(409, "Setup not completed");
    }
    const secret = generateWebhookSecret();
    const ref = await storeSecret(tx, { kind: "webhook_signing_secret", plaintext: secret });
    const [row] = await tx
      .insert(providerWebhooks)
      .values({
        providerId: provider.id,
        name: input.name,
        url: input.url,
        secretRef: ref.id,
        events: input.events ?? [...PROVIDER_WEBHOOK_EVENTS],
        active: input.active,
      })
      .returning();
    if (!row) {
      throw new Error("provider webhook insert returned no row");
    }
    await record(deps, tx, actor, PROVIDER_WEBHOOK_AUDIT_ACTIONS.created, row.id, {
      name: row.name,
      origin: urlOrigin(row.url),
      events: row.events,
      active: row.active,
    });
    return { ...(await toDto(tx, row)), secret };
  });
}

export async function updateProviderWebhook(
  deps: Deps,
  id: string,
  patch: UpdateProviderWebhookInput,
  actor: ProviderWebhookActor,
): Promise<ProviderWebhookDto> {
  return deps.providerDb.transaction(async (tx) => {
    const before = await find(tx, id);
    const set: Partial<typeof providerWebhooks.$inferInsert> = {};
    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined && patch.name !== before.name) {
      set.name = patch.name;
      changes.name = { from: before.name, to: patch.name };
    }
    if (patch.url !== undefined && patch.url !== before.url) {
      set.url = patch.url;
      changes.origin = { from: urlOrigin(before.url), to: urlOrigin(patch.url) };
    }
    if (patch.events !== undefined) {
      set.events = patch.events;
      changes.events = { from: before.events, to: patch.events };
    }
    if (patch.active !== undefined && patch.active !== before.active) {
      set.active = patch.active;
      changes.active = { from: before.active, to: patch.active };
    }
    const [row] = await tx
      .update(providerWebhooks)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(providerWebhooks.id, id))
      .returning();
    if (!row) {
      throw notFound();
    }
    await record(deps, tx, actor, PROVIDER_WEBHOOK_AUDIT_ACTIONS.updated, id, changes);
    return toDto(tx, row);
  });
}

export async function deleteProviderWebhook(
  deps: Deps,
  id: string,
  actor: ProviderWebhookActor,
): Promise<void> {
  await deps.providerDb.transaction(async (tx) => {
    const row = await find(tx, id);
    await tx.delete(providerWebhooks).where(eq(providerWebhooks.id, id));
    if (row.secretRef) {
      await deleteSecret(tx, { id: row.secretRef, tenantId: null });
    }
    await record(deps, tx, actor, PROVIDER_WEBHOOK_AUDIT_ACTIONS.deleted, id, {
      name: row.name,
      origin: urlOrigin(row.url),
    });
  });
}

export async function rotateProviderWebhookSecret(
  deps: Deps,
  id: string,
  actor: ProviderWebhookActor,
): Promise<ProviderWebhookWithSecretDto> {
  return deps.providerDb.transaction(async (tx) => {
    const row = await find(tx, id);
    const secret = generateWebhookSecret();
    let secretRef = row.secretRef;
    if (secretRef) {
      await replaceSecret(tx, { id: secretRef, tenantId: null }, secret);
    } else {
      secretRef = (await storeSecret(tx, { kind: "webhook_signing_secret", plaintext: secret })).id;
      await tx.update(providerWebhooks).set({ secretRef }).where(eq(providerWebhooks.id, id));
    }
    await record(deps, tx, actor, PROVIDER_WEBHOOK_AUDIT_ACTIONS.secretRotated, id, {});
    return { ...(await toDto(tx, { ...row, secretRef })), secret };
  });
}

/** Queue `webhook.test` for this webhook alone; 409 while it is paused. */
export async function sendProviderWebhookTest(
  deps: Deps,
  id: string,
  actor: ProviderWebhookActor,
  now: Date = new Date(),
): Promise<ProviderWebhookDeliveryDto> {
  return deps.providerDb.transaction(async (tx) => {
    const row = await find(tx, id);
    if (!row.active) {
      throw new ProblemError(409, "Webhook paused", {
        type: "urn:restow:problem:webhook-paused",
        detail: "The webhook is paused. Activate it before sending deliveries.",
      });
    }
    const [deliveryId] = await queueProviderWebhookEvent(tx, {
      event: WEBHOOK_TEST_EVENT,
      data: { message: "Test delivery of a provider webhook.", providerWebhookId: id },
      now,
      webhookId: id,
    });
    await record(deps, tx, actor, PROVIDER_WEBHOOK_AUDIT_ACTIONS.tested, id, {
      deliveryId,
    });
    const [delivery] = await tx
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId as string))
      .limit(1);
    if (!delivery) {
      throw new Error("provider webhook test delivery was not queued");
    }
    return toDeliveryDto(delivery);
  });
}

/** The latest deliveries of a webhook, newest first. */
export async function listProviderWebhookDeliveries(
  providerDb: Database,
  id: string,
): Promise<{ items: ProviderWebhookDeliveryDto[] }> {
  await find(providerDb, id);
  const rows = await providerDb
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.providerWebhookId, id))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(PROVIDER_DELIVERY_LOG_LIMIT);
  return { items: rows.map(toDeliveryDto) };
}
