import { type Context, Hono } from "hono";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import {
  type SessionEnv,
  refuseApiKeys,
  requireProviderAdmin,
  requireSession,
} from "../../middleware/session.js";
import { parseJsonBody } from "../../schemas.js";
import { updateService } from "./instance.js";
import { scheduleUpdateInputSchema, updateSettingsInputSchema } from "./schemas.js";
import type { Actor, UpdateService } from "./service.js";

/**
 * /api/v1/updates — the Updates tab of the settings, for provider admins
 * (changes need the provider team's owner role, lib/provider-access.ts):
 *
 *   GET    /                        settings, check, releases, updater, maintenance, last run
 *   PATCH  /settings                switch the check, source, channel, access token (write-only)
 *   POST   /check                   check now
 *   POST   /maintenance             announce an update: { version, leadSeconds }
 *   DELETE /maintenance             cancel an announced update (until it starts)
 *   POST   /maintenance/dismiss     clear a finished run from the tab
 *
 * /api/v1/maintenance — every signed-in user:
 *
 *   GET    /                        whether an update is announced or running (banner, modal)
 *
 * Responses never contain the access token. API keys are refused (403): these
 * are web UI routes.
 *
 * Changing the source or the access token and announcing an update decide what
 * code the updater runs on the host. They need a recent sign-in on top of the
 * owner role (lib/recent-sign-in.ts): an older session gets 403
 * `urn:restow:problem:recent-sign-in-required` and the web app asks the person
 * to confirm with their passkey or to sign in again.
 */

function actorOf(c: Context<SessionEnv>): Actor {
  const user = c.get("user");
  return { id: user.id, email: user.email, ip: clientIp(c) };
}

export function buildUpdatesRoutes(service: UpdateService): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  routes.use("*", refuseApiKeys, requireProviderAdmin);

  routes.get("/", async (c) => c.json(await service.view()));

  routes.patch("/settings", async (c) => {
    const input = await parseJsonBody(c.req, updateSettingsInputSchema);
    if (input.sourceUrl !== undefined || input.token !== undefined) {
      assertRecentSignIn(c.get("auth").session);
    }
    return c.json(await service.saveSettings(input, actorOf(c)));
  });

  routes.post("/check", async (c) => c.json(await service.checkNow(actorOf(c))));

  routes.post("/maintenance", async (c) => {
    const input = await parseJsonBody(c.req, scheduleUpdateInputSchema);
    assertRecentSignIn(c.get("auth").session);
    return c.json(await service.schedule(input, actorOf(c)));
  });

  routes.delete("/maintenance", async (c) => c.json(await service.cancel(actorOf(c))));

  routes.post("/maintenance/dismiss", async (c) => c.json(await service.dismiss(actorOf(c))));

  return routes;
}

export function buildMaintenanceRoutes(service: UpdateService): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  routes.use("*", refuseApiKeys, requireSession);
  routes.get("/", async (c) => c.json(await service.maintenance()));
  return routes;
}

export const updatesRoutes = buildUpdatesRoutes(updateService);
export const maintenanceRoutes = buildMaintenanceRoutes(updateService);
