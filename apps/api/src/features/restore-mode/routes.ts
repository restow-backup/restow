import type { RestoreModeGuard } from "@restow/core";
import type { Database } from "@restow/db";
import { type Context, Hono } from "hono";
import { providerDb } from "../../db.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import { refuseApiKeys, requireProviderAdmin, type SessionEnv } from "../../middleware/session.js";
import { parseJsonBody } from "../../schemas.js";
import { apiRestoreModeGuard } from "./instance.js";
import {
  endRestoreModeInputSchema,
  importRestoreModeKeysInputSchema,
  startRestoreModeInputSchema,
} from "./schemas.js";
import {
  checkRestoreMode,
  endRestoreModeConfirmed,
  importRestoreModeKeys,
  restoreModeBanner,
  restoreModeView,
  startRestoreMode,
} from "./service.js";

/**
 * /api/v1/restore-mode: restore mode after restoring a database dump (docs/STORAGE.md,
 * "Restore mode and progress markers"), for provider admins; changing it needs the provider
 * team's owner role (lib/provider-access.ts) and a recent sign-in:
 *
 *   GET    /             the active restore mode, its history, the comparison per target,
 *                        refused deletions, held jobs, unknown key versions, key findings
 *   GET    /banner       whether restore mode is on (the banner on every page)
 *   POST   /check        compare every tenant's storage with the database now
 *   POST   /start        switch it on: { reason }
 *   POST   /import-keys  take key versions found in storage into the database: { tenantId? }
 *   POST   /end          end it: { checked, confirmation: "END", storageOnlyData, acceptUnreachable? }
 *
 * API keys are refused (403): these are web UI routes.
 */

function actorOf(c: Context<SessionEnv>) {
  const user = c.get("user");
  return { label: user.email, userId: user.id, email: user.email, ip: clientIp(c) };
}

export function buildRestoreModeRoutes(
  db: Database = providerDb,
  guard: () => RestoreModeGuard = apiRestoreModeGuard,
): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  routes.use("*", refuseApiKeys, requireProviderAdmin);

  routes.get("/", async (c) => c.json(await restoreModeView(db)));

  routes.get("/banner", async (c) => c.json(await restoreModeBanner(db)));

  routes.post("/check", async (c) => {
    const checks = await checkRestoreMode(db, guard());
    return c.json({
      checks: checks.map((check) => ({
        tenantId: check.tenantId,
        outcome: check.outcome,
        targets: check.targets,
        activated: check.activated,
      })),
      view: await restoreModeView(db),
    });
  });

  routes.post("/start", async (c) => {
    const input = await parseJsonBody(c.req, startRestoreModeInputSchema);
    assertRecentSignIn(c.get("auth").session);
    const started = await startRestoreMode(db, {
      source: "api",
      reason: input.reason,
      actor: actorOf(c),
    });
    guard().forgetChecks();
    return c.json({ ...started, view: await restoreModeView(db) });
  });

  routes.post("/import-keys", async (c) => {
    const input = await parseJsonBody(c.req, importRestoreModeKeysInputSchema);
    assertRecentSignIn(c.get("auth").session);
    const result = await importRestoreModeKeys(db, {
      actor: actorOf(c),
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    });
    return c.json(result);
  });

  routes.post("/end", async (c) => {
    const input = await parseJsonBody(c.req, endRestoreModeInputSchema);
    assertRecentSignIn(c.get("auth").session);
    const result = await endRestoreModeConfirmed(db, guard(), { ...input, actor: actorOf(c) });
    return c.json({ ...result, view: await restoreModeView(db) });
  });

  return routes;
}

export const restoreModeRoutes = buildRestoreModeRoutes();
