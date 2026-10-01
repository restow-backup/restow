import { type Context, Hono } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  createImportSchema,
  createUploadSchema,
  folderQuerySchema,
  importIdParamSchema,
  listImportsQuerySchema,
  segmentParamsSchema,
  uploadIdParamSchema,
} from "./schemas.js";
import {
  type ImportActor,
  cancelImport,
  cancelUpload,
  completeUpload,
  createImport,
  createUpload,
  getImport,
  getImportConfig,
  getUpload,
  listFolder,
  listImports,
  listUploads,
  putSegment,
} from "./service.js";

/**
 * /api/v1/imports: import mail files (EML, MSG, MBOX, ZIP, folder trees) into
 * an imported mailbox (docs/IMPORT.md). Every route needs the tenant_admin role.
 *
 * Static segments are registered before `/:id` so they never match as ids.
 * The segment upload is the one route with a raw body: it accepts
 * `application/octet-stream` next to JSON (middleware/browser-request.ts) and
 * is read with a hard size cap (body.ts).
 */

export const importsRoutes = new Hono<TenantEnv>();

const tenantAdmin = requireTenant("tenant_admin");
const tenantAdminRawBody = requireTenant("tenant_admin", { allowOctetStream: true });

function actorOf(c: Context<TenantEnv>): ImportActor {
  const user = c.get("user");
  return { role: c.get("role"), userId: user.id, email: user.email, ip: clientIp(c) };
}

importsRoutes.get("/config", tenantAdmin, async (c) => {
  return c.json(await getImportConfig(db, c.get("tenantId"), c.get("tenant").slug));
});

importsRoutes.get("/folder", tenantAdmin, async (c) => {
  const query = parseOrProblem(folderQuerySchema, c.req.query());
  return c.json(await listFolder(c.get("tenant").slug, query));
});

importsRoutes.get("/uploads", tenantAdmin, async (c) => {
  return c.json({ items: await listUploads(db, c.get("tenantId"), actorOf(c)) });
});

importsRoutes.post("/uploads", tenantAdmin, async (c) => {
  const input = await parseJsonBody(c.req, createUploadSchema);
  return c.json(await createUpload(db, c.get("tenantId"), actorOf(c), input), 201);
});

importsRoutes.get("/uploads/:id", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(uploadIdParamSchema, c.req.param());
  return c.json(await getUpload(db, c.get("tenantId"), actorOf(c), id));
});

importsRoutes.put("/uploads/:id/segments/:index", tenantAdminRawBody, async (c) => {
  const { id, index } = parseOrProblem(segmentParamsSchema, c.req.param());
  const receipt = await putSegment(db, c.get("tenantId"), actorOf(c), id, index, {
    body: c.req.raw.body,
    contentLength: c.req.header("content-length"),
    sha256: c.req.header("x-segment-sha256"),
  });
  return c.json(receipt);
});

importsRoutes.post("/uploads/:id/complete", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(uploadIdParamSchema, c.req.param());
  return c.json(await completeUpload(db, c.get("tenantId"), actorOf(c), id));
});

importsRoutes.delete("/uploads/:id", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(uploadIdParamSchema, c.req.param());
  await cancelUpload(db, c.get("tenantId"), actorOf(c), id);
  return c.body(null, 204);
});

importsRoutes.post("/", tenantAdmin, async (c) => {
  const input = await parseJsonBody(c.req, createImportSchema);
  return c.json(
    await createImport(db, c.get("tenantId"), c.get("tenant").slug, actorOf(c), input),
    202,
  );
});

importsRoutes.get("/", tenantAdmin, async (c) => {
  const query = parseOrProblem(listImportsQuerySchema, c.req.query());
  return c.json({ items: await listImports(db, c.get("tenantId"), query) });
});

importsRoutes.get("/:id", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(importIdParamSchema, c.req.param());
  return c.json(await getImport(db, c.get("tenantId"), c.get("tenant").slug, id));
});

importsRoutes.post("/:id/cancel", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(importIdParamSchema, c.req.param());
  return c.json(await cancelImport(db, c.get("tenantId"), c.get("tenant").slug, actorOf(c), id));
});
