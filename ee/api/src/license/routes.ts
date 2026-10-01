import { type Context, Hono } from "hono";
import { providerDb } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import {
  type SessionEnv,
  requireProviderAdmin,
} from "../../../../apps/api/src/middleware/session.js";
import { parseJsonBody } from "../../../../apps/api/src/schemas.js";
import { installLicenseSchema } from "./schemas.js";
import { type LicenseActor, getLicenseState, installLicense, removeLicense } from "./service.js";

/**
 * /api/v1/license — the installation's edition and its license key.
 * Installation-level and therefore reserved for provider admins; changes are
 * written to the installation audit chain, so it all runs on the installation
 * pool. Unguarded: managing the key is what unlocks everything else.
 *
 *   GET    /   current state (edition, where it comes from, installed key, verification key)
 *   POST   /   { key } verify offline and install; 422 with a `reason` when rejected
 *   DELETE /   remove the installed key; the edition without a key applies again
 */

export const licenseRoutes = new Hono<SessionEnv>();

/** Mount path below /api/v1. */
export const LICENSE_PATH = "/license";

function actorOf(c: Context<SessionEnv>): LicenseActor {
  const user = c.get("user");
  return { id: user.id, email: user.email, ip: clientIp(c) };
}

licenseRoutes.get("/", requireProviderAdmin, async (c) => {
  return c.json(await getLicenseState(providerDb));
});

licenseRoutes.post("/", requireProviderAdmin, async (c) => {
  const input = await parseJsonBody(c.req, installLicenseSchema);
  return c.json(await installLicense(providerDb, input.key, actorOf(c)));
});

licenseRoutes.delete("/", requireProviderAdmin, async (c) => {
  return c.json(await removeLicense(providerDb, actorOf(c)));
});

export const licenseRouteContribution: SessionRouteContribution = {
  path: LICENSE_PATH,
  routes: licenseRoutes,
};
