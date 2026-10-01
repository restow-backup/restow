import { type Context, Hono } from "hono";
import { db, providerDb } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireProviderAdmin, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { apiKeyParamSchema, createApiKeySchema } from "./schemas.js";
import {
  type KeyActor,
  type KeyScope,
  createKey,
  listKeys,
  listProviderKeys,
  revokeKey,
} from "./service.js";

/**
 * /api/v1/api-keys — API keys for RMM/PSA integrations.
 *
 *   GET    /                 keys of the active tenant (tenant admin)
 *   POST   /                 create a tenant key; the token is in this response only
 *   DELETE /:id              revoke a tenant key (the row stays for the audit trail)
 *   GET    /provider         provider keys and whether they can be created
 *   POST   /provider         create a provider key (while `apiKeys.provider` is on)
 *   DELETE /provider/:id     revoke a provider key
 *
 * Managing keys needs a signed-in person: an API key can never create or
 * revoke keys. Every change is audited with the acting user and client IP.
 * Provider keys belong to no tenant (and write to the installation audit
 * chain), so they are managed on the installation pool; tenant keys on the
 * application pool, pinned to their tenant.
 */

export const apikeysRoutes = new Hono<TenantEnv>();

const tenantAdmin = requireTenant("tenant_admin");

/** The signed-in person behind a request (both env shapes carry `user`). */
function actorOf(c: Context, user: { id: string; email: string }): KeyActor {
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

function tenantScope(c: Context<TenantEnv>): KeyScope {
  return { kind: "tenant", tenantId: c.get("tenantId") };
}

const PROVIDER: KeyScope = { kind: "provider" };

/** Responses that carry a token must never be cached anywhere. */
function noStore(c: Context): void {
  c.header("Cache-Control", "no-store");
}

// --- Provider keys (registered first: static paths before `/:id`) -----------------

apikeysRoutes.get("/provider", requireProviderAdmin, async (c) => {
  return c.json(await listProviderKeys(providerDb));
});

apikeysRoutes.post("/provider", requireProviderAdmin, async (c) => {
  // createKey() (features/apikeys/service.ts) refuses a provider-scope key while
  // `apiKeys.provider` is off (lib/features.ts).
  const input = await parseJsonBody(c.req, createApiKeySchema);
  const created = await createKey(providerDb, PROVIDER, input, actorOf(c, c.get("user")));
  noStore(c);
  return c.json(created, 201);
});

apikeysRoutes.delete("/provider/:id", requireProviderAdmin, async (c) => {
  const { id } = parseOrProblem(apiKeyParamSchema, c.req.param());
  return c.json(await revokeKey(providerDb, PROVIDER, id, actorOf(c, c.get("user"))));
});

// --- Tenant keys -------------------------------------------------------------------

apikeysRoutes.get("/", tenantAdmin, async (c) => {
  return c.json({ items: await listKeys(db, tenantScope(c)) });
});

apikeysRoutes.post("/", tenantAdmin, async (c) => {
  const input = await parseJsonBody(c.req, createApiKeySchema);
  const created = await createKey(db, tenantScope(c), input, actorOf(c, c.get("user")));
  noStore(c);
  return c.json(created, 201);
});

apikeysRoutes.delete("/:id", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(apiKeyParamSchema, c.req.param());
  return c.json(await revokeKey(db, tenantScope(c), id, actorOf(c, c.get("user"))));
});
