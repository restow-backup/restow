import { type Context, Hono } from "hono";
import { db } from "../../db.js";
import { type TenantAccessEnv, requireTenantOrApiKey } from "../../middleware/apiKey.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  createWebhookSchema,
  deliveriesQuerySchema,
  deliveryParamSchema,
  updateWebhookSchema,
  webhookParamSchema,
} from "./schemas.js";
import {
  createWebhook,
  deleteWebhook,
  getDelivery,
  getWebhook,
  listDeliveries,
  listEvents,
  listWebhooks,
  redeliver,
  rotateWebhookSecret,
  sendTestEvent,
  updateWebhook,
} from "./service.js";

/**
 * /api/v1/webhooks — outbound webhooks of the active tenant.
 *
 *   GET    /events                                    the subscribable events
 *   GET    /                                          webhooks with delivery stats
 *   POST   /                                          create; the signing secret is in this response only
 *   GET    /:id                                       one webhook
 *   PATCH  /:id                                       change name, URL, events, active
 *   DELETE /:id                                       delete with its deliveries and secret
 *   POST   /:id/secret                                rotate the signing secret (shown once)
 *   POST   /:id/test                                  queue a `webhook.test` delivery
 *   GET    /:id/deliveries?status=&limit=&cursor=     delivery log, newest first
 *   GET    /:id/deliveries/:deliveryId                one delivery with its payload
 *   POST   /:id/deliveries/:deliveryId/redeliver      send a finished delivery again
 *
 * The same surface serves the web UI (tenant admins, provider admins) and
 * integrations with an API key holding `webhooks:manage` (a provider key names
 * the tenant in `X-Restow-Tenant`). Every change is audited.
 */

export const webhooksRoutes = new Hono<TenantAccessEnv>();

const access = requireTenantOrApiKey("webhooks:manage", "tenant_admin");

/** Responses that carry a signing secret must never be cached anywhere. */
function noStore(c: Context): void {
  c.header("Cache-Control", "no-store");
}

// Static path first, so it is never read as a webhook id.
webhooksRoutes.get("/events", access, (c) => c.json(listEvents()));

webhooksRoutes.get("/", access, async (c) => {
  return c.json({ items: await listWebhooks(db, c.get("tenantId")) });
});

webhooksRoutes.post("/", access, async (c) => {
  const input = await parseJsonBody(c.req, createWebhookSchema);
  const created = await createWebhook(db, c.get("tenantId"), input, c.get("actor"));
  noStore(c);
  return c.json(created, 201);
});

webhooksRoutes.get("/:id", access, async (c) => {
  const { id } = parseOrProblem(webhookParamSchema, c.req.param());
  return c.json(await getWebhook(db, c.get("tenantId"), id));
});

webhooksRoutes.patch("/:id", access, async (c) => {
  const { id } = parseOrProblem(webhookParamSchema, c.req.param());
  const patch = await parseJsonBody(c.req, updateWebhookSchema);
  return c.json(await updateWebhook(db, c.get("tenantId"), id, patch, c.get("actor")));
});

webhooksRoutes.delete("/:id", access, async (c) => {
  const { id } = parseOrProblem(webhookParamSchema, c.req.param());
  await deleteWebhook(db, c.get("tenantId"), id, c.get("actor"));
  return c.body(null, 204);
});

webhooksRoutes.post("/:id/secret", access, async (c) => {
  const { id } = parseOrProblem(webhookParamSchema, c.req.param());
  const rotated = await rotateWebhookSecret(db, c.get("tenantId"), id, c.get("actor"));
  noStore(c);
  return c.json(rotated);
});

webhooksRoutes.post("/:id/test", access, async (c) => {
  const { id } = parseOrProblem(webhookParamSchema, c.req.param());
  return c.json(await sendTestEvent(db, c.get("tenantId"), id, c.get("actor")), 202);
});

webhooksRoutes.get("/:id/deliveries", access, async (c) => {
  const { id } = parseOrProblem(webhookParamSchema, c.req.param());
  const query = parseOrProblem(deliveriesQuerySchema, c.req.query());
  return c.json(await listDeliveries(db, c.get("tenantId"), id, query));
});

webhooksRoutes.get("/:id/deliveries/:deliveryId", access, async (c) => {
  const { id, deliveryId } = parseOrProblem(deliveryParamSchema, c.req.param());
  return c.json(await getDelivery(db, c.get("tenantId"), id, deliveryId));
});

webhooksRoutes.post("/:id/deliveries/:deliveryId/redeliver", access, async (c) => {
  const { id, deliveryId } = parseOrProblem(deliveryParamSchema, c.req.param());
  return c.json(await redeliver(db, c.get("tenantId"), id, deliveryId, c.get("actor")), 202);
});
