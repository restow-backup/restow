import type { Database } from "@restow/db";
import { type Context, Hono } from "hono";
import { providerDb } from "../../db.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import { refuseApiKeys, requireProviderAdmin, type SessionEnv } from "../../middleware/session.js";
import { parseJsonBody } from "../../schemas.js";
import { createJoinTokenSchema } from "./schemas.js";
import { clusterView, createJoinToken, removeNode, revokeJoinToken } from "./service.js";

/**
 * /api/v1/cluster: Installation > Cluster (docs/SIZING.md, "Several hosts: worker nodes"), for
 * the provider team's owner only (lib/provider-access.ts); every change needs a recent sign-in:
 *
 *   GET    /                   the nodes, the open join tokens, what a node needs, the database
 *   POST   /join-tokens        a one-time join token: { nodeName, expectedAddress?, ttlMinutes?,
 *                              standbyScheduler? }; the token is in this answer only
 *   DELETE /join-tokens/:id    revoke an open token
 *   DELETE /nodes/:id          remove a node: its database logins are dropped
 *
 * API keys are refused (403): these are web UI routes.
 */

function actorOf(c: Context<SessionEnv>) {
  const user = c.get("user");
  return { userId: user.id, email: user.email, ip: clientIp(c) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildClusterRoutes(db: Database = providerDb): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  routes.use("*", refuseApiKeys, requireProviderAdmin);

  routes.get("/", async (c) => c.json(await clusterView(db)));

  routes.post("/join-tokens", async (c) => {
    const input = await parseJsonBody(c.req, createJoinTokenSchema);
    assertRecentSignIn(c.get("auth").session);
    const created = await createJoinToken(db, { ...input, actor: actorOf(c) });
    c.header("Cache-Control", "no-store");
    return c.json(created, 201);
  });

  routes.delete("/join-tokens/:id", async (c) => {
    assertRecentSignIn(c.get("auth").session);
    const id = c.req.param("id");
    if (!UUID.test(id)) {
      return c.json({ type: "about:blank", title: "Not found", status: 404 }, 404);
    }
    await revokeJoinToken(db, id, actorOf(c));
    return c.body(null, 204);
  });

  routes.delete("/nodes/:id", async (c) => {
    assertRecentSignIn(c.get("auth").session);
    const id = c.req.param("id");
    if (!UUID.test(id)) {
      return c.json({ type: "about:blank", title: "Not found", status: 404 }, 404);
    }
    await removeNode(db, id, actorOf(c));
    return c.body(null, 204);
  });

  return routes;
}

export const clusterRoutes = buildClusterRoutes();
