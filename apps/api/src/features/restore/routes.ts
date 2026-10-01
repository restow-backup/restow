import { Readable } from "node:stream";
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
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { contentDisposition } from "./headers.js";
import {
  createRestoreSchema,
  listRestoresQuerySchema,
  restoreIdParamSchema,
  restoreTargetsQuerySchema,
} from "./schemas.js";
import {
  type RestoreActor,
  cancelRestore,
  createRestore,
  getRestore,
  listRestores,
  listTargets,
  openDownload,
} from "./service.js";

/**
 * /api/v1/restore — request, watch, cancel and download restores.
 *
 * `tenant_user` may use every route except the target suggestions; the
 * service narrows end users to their own objects and to original/download
 * targets (service.ts).
 */

export const restoreRoutes = new Hono<TenantEnv>();

const tenantUser = requireTenant("tenant_user");
const tenantAdmin = requireTenant("tenant_admin");

/**
 * The download is a plain browser navigation, which cannot carry the
 * `X-Restow-Tenant` header; the tenant id may therefore also arrive as the
 * `tenant` query parameter. Otherwise identical to requireTenant("tenant_user").
 */
const tenantUserForDownload: MiddlewareHandler<TenantEnv> = async (c, next) => {
  const state = await authenticate(c.req.raw.headers);
  const selector = c.req.header(TENANT_HEADER) ?? c.req.query("tenant");
  const { tenant, role } = await resolveTenantAccess(state, selector, "tenant_user");
  c.set("auth", state.auth);
  c.set("user", state.user);
  c.set("isProviderAdmin", state.isProviderAdmin);
  c.set("memberships", state.memberships);
  c.set("tenantId", tenant.id);
  c.set("tenant", tenant);
  c.set("role", role);
  await next();
};

function actorOf(c: Context<TenantEnv>): RestoreActor {
  const user = c.get("user");
  return { role: c.get("role"), userId: user.id, email: user.email, ip: clientIp(c) };
}

// Static segments are registered before `/:id` so they never match as ids.

restoreRoutes.post("/", tenantUser, async (c) => {
  const input = await parseJsonBody(c.req, createRestoreSchema);
  return c.json(await createRestore(db, c.get("tenantId"), actorOf(c), input), 202);
});

restoreRoutes.get("/", tenantUser, async (c) => {
  const query = parseOrProblem(listRestoresQuerySchema, c.req.query());
  return c.json({ items: await listRestores(db, c.get("tenantId"), actorOf(c), query) });
});

restoreRoutes.get("/targets", tenantAdmin, async (c) => {
  const { objectId } = parseOrProblem(restoreTargetsQuerySchema, c.req.query());
  return c.json({ items: await listTargets(db, c.get("tenantId"), actorOf(c), objectId) });
});

restoreRoutes.get("/:id", tenantUser, async (c) => {
  const { id } = parseOrProblem(restoreIdParamSchema, c.req.param());
  return c.json(await getRestore(db, c.get("tenantId"), actorOf(c), id));
});

restoreRoutes.post("/:id/cancel", tenantUser, async (c) => {
  const { id } = parseOrProblem(restoreIdParamSchema, c.req.param());
  return c.json(await cancelRestore(db, c.get("tenantId"), actorOf(c), id));
});

restoreRoutes.get("/:id/download", tenantUserForDownload, async (c) => {
  const { id } = parseOrProblem(restoreIdParamSchema, c.req.param());
  const download = await openDownload(db, c.get("tenantId"), actorOf(c), id);
  // Streamed straight from storage: nothing is buffered in the API process.
  const body = Readable.toWeb(download.stream) as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(download.size),
      "content-disposition": contentDisposition(download.fileName),
      "cache-control": "private, no-store",
    },
  });
});
