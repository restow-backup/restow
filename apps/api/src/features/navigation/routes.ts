import type { Database } from "@restow/db";
import { Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { isTenantAdmin } from "../../middleware/rbac.js";
import { requireTenant, type TenantEnv } from "../../middleware/session.js";
import { archiveAvailability } from "../archive/availability.js";

/**
 * GET /api/v1/navigation: what the menu of the active tenant offers this person,
 * beyond roles and the installation's gated features (which `/me` already
 * carries): entries that depend on the tenant's own state.
 *
 *   offers.archive   the entry "Archive" and the restore explorer's source "From the
 *                    archive" (features/archive/availability.ts); always false for
 *                    someone who is not an administrator of the tenant, who may not
 *                    read the archive at all
 *
 * The web asks once per tenant and hides such an entry until the answer is in
 * (apps/web/src/lib/use-nav-items.ts), so nothing appears that then vanishes.
 */
export interface NavigationDto {
  offers: { archive: boolean };
}

export interface NavigationRoutesDeps {
  db: Database;
  requireMember: MiddlewareHandler<TenantEnv>;
  /** The installation pool the feature gates read on (tests); the API's shared one otherwise. */
  installation?: Database;
}

export function buildNavigationRoutes(deps: NavigationRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  routes.get("/", deps.requireMember, async (c) => {
    const admin = isTenantAdmin(c.get("role"));
    const archive = admin
      ? (await archiveAvailability(deps.db, c.get("tenantId"), deps.installation)).offered
      : false;
    const body: NavigationDto = { offers: { archive } };
    return c.json(body, 200, { "cache-control": "private, no-store" });
  });
  return routes;
}

export const navigationRoutes = buildNavigationRoutes({
  db,
  requireMember: requireTenant("tenant_user"),
});
