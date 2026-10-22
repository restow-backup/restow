import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { config } from "../../../../apps/api/src/config.js";
import { db, providerDb } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import type { ArchiveActor } from "../../../../apps/api/src/features/archive/service.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import { requireTenant, type TenantEnv } from "../../../../apps/api/src/middleware/session.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import { capabilityGuard } from "../license/gate.js";
import {
  ensureForwardAddress,
  type ForwardingEnvironment,
  getForwarding,
  rotateForwardAddress,
} from "./service.js";

/**
 * /api/v1/archive/forwarding (docs/IMAP.md "Weiterleitung"), next to the journal setup:
 *
 *   GET  /                      the IMAP accounts with their archive address (none is issued
 *                               here), the forwarded copies of the last 7 days, the tenant
 *                               address for domain-wide routing; `?wanted=true|false`,
 *                               `?cursor`, `?limit` (default 100, at most 500)
 *   POST /:objectId/address     the account's address, issued on the first call (audited)
 *   POST /:objectId/rotate      a new address; the old one is refused at once (audited)
 *
 * Tenant administrators only: an address is a credential (whoever knows it can deliver
 * into the account's archive), like the journal address. Mounted behind the capability
 * `archive.journalReceiver`: without it every path answers 404.
 */

export interface ForwardingRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
  environment: () => ForwardingEnvironment;
}

const querySchema = z.object({
  wanted: z.enum(["true", "false"]).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function actorOf(c: Context<TenantEnv>): ArchiveActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildForwardingRoutes(deps: ForwardingRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();

  routes.get("/", deps.requireAdmin, async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new ProblemError(400, "Invalid query", { detail: parsed.error.issues[0]?.message });
    }
    const { wanted, cursor, limit } = parsed.data;
    return c.json(
      await getForwarding(
        deps.db,
        c.get("tenantId"),
        {
          ...(wanted !== undefined ? { wanted: wanted === "true" } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit ? { limit } : {}),
        },
        deps.environment(),
      ),
    );
  });

  routes.post("/:objectId/address", deps.requireAdmin, async (c) => {
    return c.json(
      await ensureForwardAddress(
        deps.db,
        c.get("tenantId"),
        c.req.param("objectId"),
        actorOf(c),
        deps.environment(),
      ),
    );
  });

  routes.post("/:objectId/rotate", deps.requireAdmin, async (c) => {
    return c.json(
      await rotateForwardAddress(
        deps.db,
        c.get("tenantId"),
        c.req.param("objectId"),
        actorOf(c),
        deps.environment(),
      ),
    );
  });

  return routes;
}

/** Mount path below /api/v1 of the forwarding routes. */
export const FORWARDING_PATH = "/archive/forwarding";

export const forwardingRoutes: SessionRouteContribution = {
  path: FORWARDING_PATH,
  guard: capabilityGuard(providerDb, "archive.journalReceiver"),
  routes: buildForwardingRoutes({
    db,
    requireAdmin: requireTenant("tenant_admin"),
    environment: () => ({
      journal: config.journal,
      docsTroubleshootingUrl: config.docsTroubleshootingUrl,
    }),
  }),
};
