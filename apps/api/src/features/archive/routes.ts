import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { archiveRetentionViewFor } from "./retention-policy.js";
import { archiveItemParamSchema, archiveSearchQuerySchema } from "./schemas.js";
import { type ArchiveActor, getArchiveItem, searchArchive, verifyArchiveChain } from "./service.js";

/**
 * /api/v1/archive — search and read of the archive and chain verification
 * (docs/ARCHIVE.md).
 *
 *   GET    /search              full text search, filtered, paginated
 *   GET    /items/:id           one item's metadata (audited read)
 *   GET    /chain/verify        hash chain integrity check
 *   GET    /retention           the retention that applies to the tenant's archive (read only)
 *
 * Search and reading are part of the core. Legal holds
 * (`/archive/legal-holds`) and the rest of the GoBD layer (journal receipt,
 * enforced retention) are modules under `ee/api`, mounted next to these
 * routes through the extension points (ee/README.md).
 *
 * Known limitation: every route here needs at least tenant_admin.
 * Self-service search scoped to the signed-in end user's own mailbox is not
 * implemented: it needs the same session-user-to-mailbox linkage a
 * self-service restore would, which does not exist yet (see Known Issues in
 * the release notes).
 */

export interface ArchiveRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
}

function actorOf(c: Context<TenantEnv>): ArchiveActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildArchiveRoutes(deps: ArchiveRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();

  routes.get("/search", deps.requireAdmin, async (c) => {
    const query = parseOrProblem(archiveSearchQuerySchema, c.req.query());
    return c.json(await searchArchive(deps.db, c.get("tenantId"), query, actorOf(c)));
  });

  routes.get("/items/:id", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(archiveItemParamSchema, c.req.param());
    return c.json(await getArchiveItem(deps.db, c.get("tenantId"), id, actorOf(c)));
  });

  routes.get("/chain/verify", deps.requireAdmin, async (c) => {
    return c.json(await verifyArchiveChain(deps.db, c.get("tenantId")));
  });

  routes.get("/retention", deps.requireAdmin, async (c) => {
    return c.json(await archiveRetentionViewFor(deps.db, c.get("tenantId")));
  });

  return routes;
}

export const archiveRoutes = buildArchiveRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
});
