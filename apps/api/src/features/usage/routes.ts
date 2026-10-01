import { Hono } from "hono";
import { providerDb } from "../../db.js";
import { type SessionEnv, requireProviderAdmin } from "../../middleware/session.js";
import { loadUsage } from "./service.js";

/**
 * /api/v1/usage — the installation's protected mailboxes, in total and per
 * tenant (counting rule: @restow/core `countProtectedMailboxes`). It counts
 * every tenant, so it is the provider's and runs on the installation pool;
 * each tenant is still counted in its own pinned transaction.
 *
 *   GET /   { mailboxes, tenants: [{ id, name, slug, status, mailboxes, cap }] }
 */
export const usageRoutes = new Hono<SessionEnv>();

usageRoutes.get("/", requireProviderAdmin, async (c) => {
  return c.json(await loadUsage(providerDb));
});
