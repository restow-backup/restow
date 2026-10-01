import { z } from "zod";
import type { DeliveryErrorDto } from "../../features/webhooks/delivery-error.js";
import {
  createWebhookSchema,
  deliveriesQuerySchema,
  updateWebhookSchema,
} from "../../features/webhooks/schemas.js";
import {
  type DeliveriesPage,
  type DeliveryDto,
  type WebhookDto,
  type WebhookWithSecretDto,
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  sendTestEvent,
  updateWebhook,
} from "../../features/webhooks/service.js";
import { WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT } from "../../lib/webhooks.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps, WRITE_ERRORS } from "./api.js";
import { component } from "./components.js";
import { idParamSchema, nextCursorSchema, timestampSchema, uuidSchema } from "./schemas.js";

/**
 * Webhooks for integrations (docs/ARCHITECTURE.md, "API"): subscribe a URL to
 * events such as `job.failed` to open a ticket, rotate its secret, send a
 * test event and read the delivery log. The webhooks feature does the work
 * (validation, encrypted secret, audit, delivery queue); this module maps its
 * DTOs onto the versioned v1 shapes. Request bodies are the feature's own
 * schemas, so both surfaces accept exactly the same input.
 */

export const SIGNATURE_HEADER = "X-Restow-Signature";
export const SIGNATURE_FORMAT = "sha256=<hex>";

const DELIVERY_NOTE =
  "Deliveries are POSTed as JSON with `X-Restow-Signature: sha256=<hex>`, the HMAC-SHA-256 of the raw body under the webhook's secret, and retried with backoff.";

export const webhookEventSchema = component(
  "WebhookEvent",
  z.enum(WEBHOOK_EVENTS).describe("An event a webhook can subscribe to."),
);

export const deliveryStatusSchema = component(
  "WebhookDeliveryStatus",
  z
    .enum(["pending", "delivered", "failed"])
    .describe("`pending` waits for its (next) attempt; `failed` gave up after every retry."),
);

export const webhookSchema = component(
  "Webhook",
  z.object({
    id: uuidSchema,
    name: z.string().nullable(),
    url: z.string(),
    events: z.array(webhookEventSchema),
    active: z.boolean(),
    secretConfigured: z.boolean().describe("A signing secret is stored for the webhook."),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    stats: z.object({
      pending: z.number().int(),
      failedLast24h: z.number().int(),
      deliveredLast24h: z.number().int(),
      lastDelivery: z
        .object({
          id: uuidSchema,
          event: z.string(),
          status: deliveryStatusSchema,
          createdAt: timestampSchema,
          deliveredAt: timestampSchema.nullable(),
        })
        .nullable(),
    }),
  }),
);
export type V1WebhookDto = z.infer<typeof webhookSchema>;

export const webhookWithSecretSchema = component(
  "WebhookWithSecret",
  webhookSchema.extend({
    secret: z
      .string()
      .describe("The signing secret. Shown only in this answer; it cannot be read again."),
    signature: z
      .object({
        header: z.literal(SIGNATURE_HEADER),
        format: z.literal(SIGNATURE_FORMAT),
      })
      .describe("How deliveries are signed: HMAC-SHA-256 over the raw body with the secret."),
  }),
);
export type V1WebhookWithSecretDto = z.infer<typeof webhookWithSecretSchema>;

export const webhookListSchema = component(
  "WebhookList",
  z.object({ items: z.array(webhookSchema) }),
);

export const deliverySchema = component(
  "WebhookDelivery",
  z.object({
    id: uuidSchema,
    webhookId: uuidSchema,
    event: z.string().describe(`A subscribed event, or \`${WEBHOOK_TEST_EVENT}\`.`),
    eventId: z
      .string()
      .nullable()
      .describe("Id of the event; identical across retries, for de-duplication."),
    status: deliveryStatusSchema,
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    lastError: z
      .object({
        code: z
          .string()
          .describe("e.g. `http_error`, `timeout`, `connection_failed`, `blocked_address`."),
        httpStatus: z.number().int().nullable(),
        detail: z.string().nullable(),
      })
      .nullable(),
    nextAttemptAt: timestampSchema.nullable(),
    deliveredAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
);
export type V1DeliveryDto = z.infer<typeof deliverySchema>;

export const deliveriesPageSchema = component(
  "WebhookDeliveryPage",
  z.object({ items: z.array(deliverySchema), next: nextCursorSchema }),
);
export type V1DeliveriesPageDto = z.infer<typeof deliveriesPageSchema>;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function toV1Webhook(webhook: WebhookDto): V1WebhookDto {
  const { stats } = webhook;
  return {
    id: webhook.id,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
    active: webhook.active,
    secretConfigured: webhook.secretConfigured,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
    stats: {
      pending: stats.pending,
      failedLast24h: stats.failedLast24h,
      deliveredLast24h: stats.deliveredLast24h,
      lastDelivery: stats.lastDelivery
        ? {
            id: stats.lastDelivery.id,
            event: stats.lastDelivery.event,
            status: stats.lastDelivery.status,
            createdAt: stats.lastDelivery.createdAt,
            deliveredAt: stats.lastDelivery.deliveredAt,
          }
        : null,
    },
  };
}

export function toV1WebhookWithSecret(webhook: WebhookWithSecretDto): V1WebhookWithSecretDto {
  return {
    ...toV1Webhook(webhook),
    secret: webhook.secret,
    signature: { header: SIGNATURE_HEADER, format: SIGNATURE_FORMAT },
  };
}

function toV1Error(error: DeliveryErrorDto | null): V1DeliveryDto["lastError"] {
  return error ? { code: error.code, httpStatus: error.httpStatus, detail: error.detail } : null;
}

export function toV1Delivery(delivery: DeliveryDto): V1DeliveryDto {
  return {
    id: delivery.id,
    webhookId: delivery.webhookId,
    event: delivery.event,
    eventId: delivery.eventId,
    status: delivery.status,
    attempts: delivery.attempts,
    maxAttempts: delivery.maxAttempts,
    lastError: toV1Error(delivery.lastError),
    nextAttemptAt: delivery.nextAttemptAt,
    deliveredAt: delivery.deliveredAt,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

export function toV1Deliveries(page: DeliveriesPage): V1DeliveriesPageDto {
  return { items: page.items.map(toV1Delivery), next: page.next };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerWebhookRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;

  api.tenant(
    {
      method: "get",
      path: "/webhooks",
      operationId: "listWebhooks",
      summary: "The tenant's webhooks with their delivery statistics",
      tag: "Webhooks",
      scope: "webhooks:manage",
      errors: READ_ERRORS,
      response: {
        status: 200,
        description: "All webhooks of the tenant.",
        schema: webhookListSchema,
      },
    },
    async ({ tenant }) => ({ items: (await listWebhooks(db, tenant.id)).map(toV1Webhook) }),
  );

  api.tenant(
    {
      method: "post",
      path: "/webhooks",
      operationId: "createWebhook",
      summary: "Subscribe a URL to events",
      description: `${DELIVERY_NOTE} The signing secret is part of this answer only.`,
      tag: "Webhooks",
      scope: "webhooks:manage",
      write: true,
      body: createWebhookSchema,
      errors: WRITE_ERRORS,
      response: {
        status: 201,
        description: "The webhook with its signing secret.",
        schema: webhookWithSecretSchema,
      },
    },
    async ({ c, tenant, actor, input: { body } }) => {
      c.header("Cache-Control", "no-store");
      return toV1WebhookWithSecret(await createWebhook(db, tenant.id, body, actor));
    },
  );

  api.tenant(
    {
      method: "patch",
      path: "/webhooks/:id",
      operationId: "updateWebhook",
      summary: "Change a webhook's name, URL, events or active state",
      tag: "Webhooks",
      scope: "webhooks:manage",
      write: true,
      params: idParamSchema,
      body: updateWebhookSchema,
      errors: WRITE_ERRORS,
      response: { status: 200, description: "The changed webhook.", schema: webhookSchema },
    },
    async ({ tenant, actor, input: { params, body } }) =>
      toV1Webhook(await updateWebhook(db, tenant.id, params.id, body, actor)),
  );

  api.tenant(
    {
      method: "delete",
      path: "/webhooks/:id",
      operationId: "deleteWebhook",
      summary: "Remove a webhook with its deliveries and signing secret",
      tag: "Webhooks",
      scope: "webhooks:manage",
      write: true,
      params: idParamSchema,
      errors: WRITE_ERRORS,
      response: { status: 204, description: "Removed." },
    },
    async ({ tenant, actor, input: { params } }) => {
      await deleteWebhook(db, tenant.id, params.id, actor);
      return null;
    },
  );

  api.tenant(
    {
      method: "post",
      path: "/webhooks/:id/secret",
      operationId: "rotateWebhookSecret",
      summary: "Replace a webhook's signing secret",
      description:
        "The new secret applies to every delivery from now on and is part of this answer only.",
      tag: "Webhooks",
      scope: "webhooks:manage",
      write: true,
      params: idParamSchema,
      errors: WRITE_ERRORS,
      response: {
        status: 200,
        description: "The webhook with its new signing secret.",
        schema: webhookWithSecretSchema,
      },
    },
    async ({ c, tenant, actor, input: { params } }) => {
      c.header("Cache-Control", "no-store");
      return toV1WebhookWithSecret(await rotateWebhookSecret(db, tenant.id, params.id, actor));
    },
  );

  api.tenant(
    {
      method: "post",
      path: "/webhooks/:id/test",
      operationId: "sendWebhookTest",
      summary: "Queue a `webhook.test` delivery to check the receiver",
      tag: "Webhooks",
      scope: "webhooks:manage",
      write: true,
      params: idParamSchema,
      errors: WRITE_ERRORS,
      response: { status: 202, description: "The queued test delivery.", schema: deliverySchema },
    },
    async ({ tenant, actor, input: { params } }) =>
      toV1Delivery(await sendTestEvent(db, tenant.id, params.id, actor)),
  );

  api.tenant(
    {
      method: "get",
      path: "/webhooks/:id/deliveries",
      operationId: "listWebhookDeliveries",
      summary: "Delivery log of a webhook, newest first",
      tag: "Webhooks",
      scope: "webhooks:manage",
      params: idParamSchema,
      query: deliveriesQuerySchema,
      errors: READ_ERRORS,
      response: { status: 200, description: "A page of deliveries.", schema: deliveriesPageSchema },
    },
    async ({ tenant, input: { params, query } }) =>
      toV1Deliveries(await listDeliveries(db, tenant.id, params.id, query)),
  );
}
