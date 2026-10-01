import { Readable } from "node:stream";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import {
  TENANT_HEADER,
  type TenantEnv,
  assertProviderRoute,
  authenticate,
  requireTenant,
  resolveTenantAccess,
} from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { contentDisposition } from "../restore/headers.js";
import { createExportSchema, exportIdParamSchema, listExportsQuerySchema } from "./schemas.js";
import {
  type ExportActor,
  cancelExport,
  createExport,
  getExport,
  listExports,
  listFormats,
  openDownload,
} from "./service.js";

/**
 * /api/v1/exports: request, watch, cancel and download mail exports
 * (docs/IMPORT.md).
 *
 * `tenant_user` may use every route; the service narrows end users to their
 * own mailboxes and their own requests, and to tenant admins for exports from
 * the archive (service.ts).
 */

export const exportsRoutes = new Hono<TenantEnv>();

const tenantUser = requireTenant("tenant_user");

/**
 * The download is a plain browser navigation, which cannot carry the
 * `X-Restow-Tenant` header; the tenant id may therefore also arrive as the
 * `tenant` query parameter. Otherwise identical to requireTenant("tenant_user"),
 * including the provider team's route rule (lib/provider-access.ts).
 */
const tenantUserForDownload: MiddlewareHandler<TenantEnv> = async (c, next) => {
  const state = await authenticate(c.req.raw.headers);
  assertProviderRoute(c, state);
  const selector = c.req.header(TENANT_HEADER) ?? c.req.query("tenant");
  const { tenant, role } = await resolveTenantAccess(state, selector, "tenant_user");
  c.set("auth", state.auth);
  c.set("user", state.user);
  c.set("isProviderAdmin", state.isProviderAdmin);
  c.set("providerAccess", state.providerAccess);
  c.set("memberships", state.memberships);
  c.set("tenantId", tenant.id);
  c.set("tenant", tenant);
  c.set("role", role);
  await next();
};

function actorOf(c: Context<TenantEnv>): ExportActor {
  const user = c.get("user");
  return { role: c.get("role"), userId: user.id, email: user.email, ip: clientIp(c) };
}

// Static segments are registered before `/:id` so they never match as ids.

exportsRoutes.get("/formats", tenantUser, (c) => c.json({ formats: listFormats() }));

exportsRoutes.post("/", tenantUser, async (c) => {
  const input = await parseJsonBody(c.req, createExportSchema);
  return c.json(await createExport(db, c.get("tenantId"), actorOf(c), input), 202);
});

exportsRoutes.get("/", tenantUser, async (c) => {
  const query = parseOrProblem(listExportsQuerySchema, c.req.query());
  return c.json({ items: await listExports(db, c.get("tenantId"), actorOf(c), query) });
});

exportsRoutes.get("/:id", tenantUser, async (c) => {
  const { id } = parseOrProblem(exportIdParamSchema, c.req.param());
  return c.json(await getExport(db, c.get("tenantId"), actorOf(c), id));
});

exportsRoutes.post("/:id/cancel", tenantUser, async (c) => {
  const { id } = parseOrProblem(exportIdParamSchema, c.req.param());
  return c.json(await cancelExport(db, c.get("tenantId"), actorOf(c), id));
});

exportsRoutes.get("/:id/download", tenantUserForDownload, async (c) => {
  const { id } = parseOrProblem(exportIdParamSchema, c.req.param());
  const download = await openDownload(db, c.get("tenantId"), actorOf(c), id);
  // Decrypted segment by segment straight from storage: nothing is buffered whole in the API process.
  const body = Readable.toWeb(download.stream) as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": download.contentType,
      "content-length": String(download.size),
      "content-disposition": contentDisposition(download.fileName),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
