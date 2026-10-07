import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import type { ArchiveActor } from "../../../../apps/api/src/features/archive/service.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import { type TenantEnv, requireTenant } from "../../../../apps/api/src/middleware/session.js";
import { parseJsonBody, parseOrProblem, readJsonBody } from "../../../../apps/api/src/schemas.js";
import { capabilityGuard } from "../license/gate.js";
import { createLegalHoldSchema, legalHoldParamSchema, releaseLegalHoldSchema } from "./schemas.js";
import { createLegalHold, listLegalHolds, releaseLegalHold } from "./service.js";

/**
 * /api/v1/archive/legal-holds (docs/ARCHIVE.md, Legal Hold), next to the
 * core archive routes (search, reading, chain verification):
 *
 *   GET    /       list the tenant's holds
 *   POST   /       place a hold
 *   DELETE /:id    release a hold (optional body `{ reason }`, audited)
 *
 * Tenant administrators only. Mounted behind the `archive.legalHold`
 * capability (apps/api/src/app.ts): without it every path here answers 404.
 */

export interface LegalHoldRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
}

function actorOf(c: Context<TenantEnv>): ArchiveActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildLegalHoldRoutes(deps: LegalHoldRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();

  routes.get("/", deps.requireAdmin, async (c) => {
    return c.json({ items: await listLegalHolds(deps.db, c.get("tenantId")) });
  });

  routes.post("/", deps.requireAdmin, async (c) => {
    const input = await parseJsonBody(c.req, createLegalHoldSchema);
    return c.json(await createLegalHold(deps.db, c.get("tenantId"), input, actorOf(c)), 201);
  });

  routes.delete("/:id", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(legalHoldParamSchema, c.req.param());
    // No body (API clients of the first version) is a release without a stated reason.
    const body = (await readJsonBody(c.req)) ?? {};
    const input = parseOrProblem(releaseLegalHoldSchema, body);
    return c.json(await releaseLegalHold(deps.db, c.get("tenantId"), id, actorOf(c), input));
  });

  return routes;
}

/** Mount path below /api/v1 of the legal hold routes. */
export const LEGAL_HOLDS_PATH = "/archive/legal-holds";

export const legalHoldRoutes: SessionRouteContribution = {
  path: LEGAL_HOLDS_PATH,
  guard: capabilityGuard(db, "archive.legalHold"),
  routes: buildLegalHoldRoutes({ db, requireAdmin: requireTenant("tenant_admin") }),
};
