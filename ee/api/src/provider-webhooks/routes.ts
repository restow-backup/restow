import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { providerDb } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import {
  requireProviderAdmin,
  type SessionEnv,
} from "../../../../apps/api/src/middleware/session.js";
import type { IntegrationApi, V1Deps } from "../../../../apps/api/src/routes/v1/api.js";
import { component } from "../../../../apps/api/src/routes/v1/components.js";
import { timestampSchema, uuidSchema } from "../../../../apps/api/src/routes/v1/schemas.js";
import { parseJsonBody, parseOrProblem } from "../../../../apps/api/src/schemas.js";
import { capabilityGuard } from "../license/gate.js";
import {
  createProviderWebhook,
  createProviderWebhookSchema,
  deleteProviderWebhook,
  getProviderWebhook,
  listProviderWebhookDeliveries,
  listProviderWebhooks,
  PROVIDER_WEBHOOK_EVENTS,
  type ProviderWebhookActor,
  providerWebhookParamSchema,
  rotateProviderWebhookSecret,
  sendProviderWebhookTest,
  updateProviderWebhook,
  updateProviderWebhookSchema,
} from "./service.js";

/**
 * The provider's own webhooks (0.6.0, Service Provider; ./service.ts) on two surfaces:
 *
 *   integration API, provider keys with `webhooks:manage` (the scope a tenant key manages its
 *   tenant's webhooks with):
 *     GET    /provider/webhooks                 list, with the events offered
 *     POST   /provider/webhooks                 create; the answer carries the secret once
 *     GET    /provider/webhooks/:id             one
 *     PATCH  /provider/webhooks/:id             change name, URL, events, active
 *     DELETE /provider/webhooks/:id             delete
 *     POST   /provider/webhooks/:id/secret      new secret, carried once
 *     POST   /provider/webhooks/:id/test        queue `webhook.test`
 *     GET    /provider/webhooks/:id/deliveries  the latest deliveries
 *
 *   session API for Installation › Provider API (the same paths below /api/v1/provider-webhooks);
 *   every provider role reads, the owner changes (../provider-rules.ts).
 */

const deliveryErrorSchema = z
  .object({
    code: z.string(),
    httpStatus: z.number().int().nullable(),
    detail: z.string().nullable(),
  })
  .nullable();

export const providerWebhookDeliverySchema = component(
  "ProviderWebhookDelivery",
  z.object({
    id: uuidSchema,
    event: z.string(),
    eventId: z.string().nullable().describe("The envelope's event id, the same on every retry."),
    status: z.enum(["pending", "delivered", "failed"]),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    lastError: deliveryErrorSchema,
    nextAttemptAt: timestampSchema.nullable(),
    deliveredAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  }),
);

const providerWebhookShape = z.object({
  id: uuidSchema,
  name: z.string().nullable(),
  url: z.string(),
  events: z.array(z.enum(PROVIDER_WEBHOOK_EVENTS)),
  active: z.boolean(),
  failingSince: timestampSchema
    .nullable()
    .describe("Since when attempts fail in a row; null while it delivers."),
  consecutiveFailures: z.number().int(),
  lastFailure: deliveryErrorSchema,
  pending: z.number().int().describe("Deliveries still to be sent."),
  lastDelivery: providerWebhookDeliverySchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const providerWebhookSchema = component("ProviderWebhook", providerWebhookShape);

export const providerWebhookWithSecretSchema = component(
  "ProviderWebhookWithSecret",
  providerWebhookShape.extend({
    secret: z
      .string()
      .describe(
        "The signing secret (`whsec_...`): `X-Restow-Signature` is `sha256=` and the hex HMAC-SHA-256 of the raw body under it. Only in this answer.",
      ),
  }),
);

export const providerWebhookListSchema = component(
  "ProviderWebhookList",
  z.object({
    items: z.array(providerWebhookSchema),
    events: z.array(z.enum(PROVIDER_WEBHOOK_EVENTS)).describe("The events a webhook can get."),
  }),
);

const deliveriesSchema = component(
  "ProviderWebhookDeliveryList",
  z.object({ items: z.array(providerWebhookDeliverySchema).describe("Newest first, at most 50.") }),
);

const ENVELOPE_NOTE =
  'Deliveries are signed JSON envelopes `{id, event, version, createdAt, scope: "provider", data}` with `X-Restow-Event`, `X-Restow-Delivery`, `X-Restow-Attempt` and `X-Restow-Signature: sha256=<hex HMAC-SHA-256 of the raw body>`, retried with backoff (8 attempts over about a day), at least once: deduplicate by `id`. `billing.period_closed` carries `{period, closedAt, currency, tenants, total, url}`, no tenant figures: read them at `url`.';

export function registerProviderWebhookRoutes(api: IntegrationApi, deps: V1Deps): void {
  const store = { providerDb: deps.providerDb, audit: deps.audit };
  const actorOf = (actor: { label: string; keyId: string; ip: string | null }) => ({
    label: actor.label,
    userId: null,
    ip: actor.ip,
    keyId: actor.keyId,
  });

  api.provider(
    {
      method: "get",
      path: "/provider/webhooks",
      operationId: "listProviderWebhooks",
      summary: "The provider's own webhooks",
      description: `Webhooks of the installation, not of a tenant (0.6.0): the first event is \`billing.period_closed\` of the monthly billing close. ${ENVELOPE_NOTE}`,
      tag: "Provider",
      scope: "webhooks:manage",
      errors: [400],
      response: { status: 200, description: "The webhooks.", schema: providerWebhookListSchema },
    },
    async () => listProviderWebhooks(deps.providerDb),
  );

  api.provider(
    {
      method: "post",
      path: "/provider/webhooks",
      operationId: "createProviderWebhook",
      summary: "Subscribe a URL to the provider's events",
      description: `Without \`events\` the webhook gets every event. The signing secret is part of this answer only. Recorded in the installation's audit log (\`provider_webhook.created\`). ${ENVELOPE_NOTE}`,
      tag: "Provider",
      scope: "webhooks:manage",
      write: true,
      body: createProviderWebhookSchema,
      errors: [400, 409, 422],
      response: {
        status: 201,
        description: "The webhook with its signing secret.",
        schema: providerWebhookWithSecretSchema,
      },
    },
    async ({ actor, input: { body } }) => createProviderWebhook(store, body, actorOf(actor)),
  );

  api.provider(
    {
      method: "get",
      path: "/provider/webhooks/:id",
      operationId: "getProviderWebhook",
      summary: "One of the provider's webhooks",
      tag: "Provider",
      scope: "webhooks:manage",
      params: providerWebhookParamSchema,
      errors: [400, 404, 422],
      response: { status: 200, description: "The webhook.", schema: providerWebhookSchema },
    },
    async ({ input: { params } }) => getProviderWebhook(deps.providerDb, params.id),
  );

  api.provider(
    {
      method: "patch",
      path: "/provider/webhooks/:id",
      operationId: "updateProviderWebhook",
      summary: "Change one of the provider's webhooks",
      description: "Recorded in the installation's audit log (`provider_webhook.updated`).",
      tag: "Provider",
      scope: "webhooks:manage",
      write: true,
      params: providerWebhookParamSchema,
      body: updateProviderWebhookSchema,
      errors: [400, 404, 422],
      response: { status: 200, description: "The webhook.", schema: providerWebhookSchema },
    },
    async ({ actor, input: { params, body } }) =>
      updateProviderWebhook(store, params.id, body, actorOf(actor)),
  );

  api.provider(
    {
      method: "delete",
      path: "/provider/webhooks/:id",
      operationId: "deleteProviderWebhook",
      summary: "Delete one of the provider's webhooks",
      description:
        "Its pending deliveries go with it. Recorded in the installation's audit log (`provider_webhook.deleted`).",
      tag: "Provider",
      scope: "webhooks:manage",
      write: true,
      params: providerWebhookParamSchema,
      errors: [400, 404, 422],
      response: { status: 204, description: "Deleted." },
    },
    async ({ actor, input: { params } }) => {
      await deleteProviderWebhook(store, params.id, actorOf(actor));
      return null;
    },
  );

  api.provider(
    {
      method: "post",
      path: "/provider/webhooks/:id/secret",
      operationId: "rotateProviderWebhookSecret",
      summary: "Replace a provider webhook's signing secret",
      description:
        "Applies to every delivery from now on; part of this answer only. Recorded in the installation's audit log (`provider_webhook.secret_rotated`).",
      tag: "Provider",
      scope: "webhooks:manage",
      write: true,
      params: providerWebhookParamSchema,
      errors: [400, 404, 422],
      response: {
        status: 200,
        description: "The webhook with its new signing secret.",
        schema: providerWebhookWithSecretSchema,
      },
    },
    async ({ actor, input: { params } }) =>
      rotateProviderWebhookSecret(store, params.id, actorOf(actor)),
  );

  api.provider(
    {
      method: "post",
      path: "/provider/webhooks/:id/test",
      operationId: "sendProviderWebhookTest",
      summary: "Queue a `webhook.test` delivery to a provider webhook",
      description:
        "409 while the webhook is paused. Recorded in the installation's audit log (`provider_webhook.tested`).",
      tag: "Provider",
      scope: "webhooks:manage",
      write: true,
      params: providerWebhookParamSchema,
      errors: [400, 404, 409, 422],
      response: {
        status: 202,
        description: "The queued delivery.",
        schema: providerWebhookDeliverySchema,
      },
    },
    async ({ actor, input: { params } }) =>
      sendProviderWebhookTest(store, params.id, actorOf(actor), deps.now()),
  );

  api.provider(
    {
      method: "get",
      path: "/provider/webhooks/:id/deliveries",
      operationId: "listProviderWebhookDeliveries",
      summary: "The latest deliveries of a provider webhook",
      tag: "Provider",
      scope: "webhooks:manage",
      params: providerWebhookParamSchema,
      errors: [400, 404, 422],
      response: { status: 200, description: "The deliveries.", schema: deliveriesSchema },
    },
    async ({ input: { params } }) => listProviderWebhookDeliveries(deps.providerDb, params.id),
  );
}

// ---------------------------------------------------------------------------
// Session routes (Installation › Provider API)
// ---------------------------------------------------------------------------

export interface ProviderWebhookSessionDeps {
  providerDb: Database;
  requireProvider: MiddlewareHandler<SessionEnv>;
}

function sessionActor(c: Context<SessionEnv>): ProviderWebhookActor {
  const user = c.get("user");
  return { label: user.email, userId: user.id, ip: clientIp(c) };
}

export function buildProviderWebhookSessionRoutes(
  deps: ProviderWebhookSessionDeps,
): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  const store = { providerDb: deps.providerDb };
  const id = (c: Context<SessionEnv>) =>
    parseOrProblem(providerWebhookParamSchema, c.req.param()).id;

  routes.get("/", deps.requireProvider, async (c) =>
    c.json(await listProviderWebhooks(deps.providerDb)),
  );
  routes.post("/", deps.requireProvider, async (c) => {
    const input = await parseJsonBody(c.req, createProviderWebhookSchema);
    return c.json(await createProviderWebhook(store, input, sessionActor(c)), 201);
  });
  routes.patch("/:id", deps.requireProvider, async (c) => {
    const patch = await parseJsonBody(c.req, updateProviderWebhookSchema);
    return c.json(await updateProviderWebhook(store, id(c), patch, sessionActor(c)));
  });
  routes.delete("/:id", deps.requireProvider, async (c) => {
    await deleteProviderWebhook(store, id(c), sessionActor(c));
    return c.body(null, 204);
  });
  routes.post("/:id/secret", deps.requireProvider, async (c) =>
    c.json(await rotateProviderWebhookSecret(store, id(c), sessionActor(c))),
  );
  routes.post("/:id/test", deps.requireProvider, async (c) =>
    c.json(await sendProviderWebhookTest(store, id(c), sessionActor(c)), 202),
  );
  routes.get("/:id/deliveries", deps.requireProvider, async (c) =>
    c.json(await listProviderWebhookDeliveries(deps.providerDb, id(c))),
  );
  return routes;
}

/** Mount path below /api/v1. */
export const PROVIDER_WEBHOOKS_PATH = "/provider-webhooks";

export const providerWebhookRoutes: SessionRouteContribution = {
  path: PROVIDER_WEBHOOKS_PATH,
  guard: capabilityGuard(providerDb, "provider.crossTenantApi"),
  routes: buildProviderWebhookSessionRoutes({ providerDb, requireProvider: requireProviderAdmin }),
};
