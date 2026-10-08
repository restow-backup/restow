import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import {
  TENANT_HEADER,
  type TenantEnv,
  authenticate,
  requireTenant,
  resolveTenantAccess,
} from "../../middleware/session.js";
import { parseOrProblem } from "../../schemas.js";
import { contentDisposition } from "../restore/headers.js";
import { archiveRetentionViewFor } from "./retention-policy.js";
import {
  archiveItemParamSchema,
  archiveSearchQuerySchema,
  chainVerifyQuerySchema,
} from "./schemas.js";
import {
  type ArchiveActor,
  downloadArchiveItem,
  getArchiveItem,
  previewArchiveItem,
  searchArchive,
} from "./service.js";
import { type VerifyOptions, verifyArchive } from "./verify.js";

/**
 * /api/v1/archive — search and read of the archive and chain verification
 * (docs/ARCHIVE.md).
 *
 *   GET    /search              full text search, filtered, paginated
 *   GET    /items/:id           one item's metadata (audited read)
 *   GET    /items/:id/preview   the message for the reading pane (audited read)
 *   GET    /items/:id/download  the original message as `.eml` (audited read)
 *   GET    /chain/verify        links, daily anchors and a content sample (audited; verify.ts)
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
  /**
   * The `.eml` download is a plain browser navigation, which cannot carry the
   * tenant header: this guard also takes the tenant from the `tenant` query
   * parameter (as the restore and export downloads do). Defaults to `requireAdmin`.
   */
  requireAdminForDownload?: MiddlewareHandler<TenantEnv>;
  /** The chunk reader of the content sample (tests); defaults to the tenant's storage. */
  openReader?: VerifyOptions["openReader"];
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

  routes.get("/items/:id/preview", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(archiveItemParamSchema, c.req.param());
    return c.json(await previewArchiveItem(deps.db, c.get("tenantId"), id, actorOf(c)));
  });

  routes.get(
    "/items/:id/download",
    deps.requireAdminForDownload ?? deps.requireAdmin,
    async (c) => {
      const { id } = parseOrProblem(archiveItemParamSchema, c.req.param());
      const file = await downloadArchiveItem(deps.db, c.get("tenantId"), id, actorOf(c));
      return c.body(new Uint8Array(file.content), 200, {
        "content-type": "message/rfc822",
        "content-length": String(file.content.length),
        "content-disposition": contentDisposition(file.fileName),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      });
    },
  );

  routes.get("/chain/verify", deps.requireAdmin, async (c) => {
    const query = parseOrProblem(chainVerifyQuerySchema, c.req.query());
    return c.json(
      await verifyArchive(deps.db, c.get("tenantId"), {
        contentSample: query.contentSample,
        actor: actorOf(c),
        ...(deps.openReader ? { openReader: deps.openReader } : {}),
      }),
    );
  });

  routes.get("/retention", deps.requireAdmin, async (c) => {
    return c.json(await archiveRetentionViewFor(deps.db, c.get("tenantId")));
  });

  return routes;
}

/** tenant_admin, with the tenant from the header or the `tenant` query parameter. */
const tenantAdminForDownload: MiddlewareHandler<TenantEnv> = async (c, next) => {
  const state = await authenticate(c.req.raw.headers);
  const selector = c.req.header(TENANT_HEADER) ?? c.req.query("tenant");
  const { tenant, role } = await resolveTenantAccess(state, selector, "tenant_admin");
  c.set("auth", state.auth);
  c.set("user", state.user);
  c.set("isProviderAdmin", state.isProviderAdmin);
  c.set("memberships", state.memberships);
  c.set("tenantId", tenant.id);
  c.set("tenant", tenant);
  c.set("role", role);
  await next();
};

export const archiveRoutes = buildArchiveRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
  requireAdminForDownload: tenantAdminForDownload,
});
