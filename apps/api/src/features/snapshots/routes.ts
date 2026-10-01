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
import type { Viewer } from "./access.js";
import {
  attachmentParamSchema,
  listObjectsQuerySchema,
  listSnapshotsQuerySchema,
  searchQuerySchema,
  snapshotEntryParamSchema,
  treeQuerySchema,
  uuidParamSchema,
  versionsQuerySchema,
} from "./schemas.js";
import {
  type SnapshotReader,
  listObjects,
  listSnapshots,
  listTree,
  listVersions,
  openAttachmentDownload,
  previewMailEntry,
  search,
} from "./service.js";

/**
 * /api/v1/snapshots — browsing backups for the restore explorer.
 *
 * Every route needs a tenant context; `tenant_user` is enough because the
 * service scopes end users to their own mailbox / OneDrive (access.ts). Reads
 * of backup contents (tree, versions, search) are audited by the service.
 * Every route resolves its tenant from the `X-Restow-Tenant` header, except
 * the attachment download, which also accepts the `tenant` query parameter
 * (see `tenantUserForAttachmentDownload` below).
 */

export const snapshotsRoutes = new Hono<TenantEnv>();

/** Every route but the attachment download (below): tenant from the header only. */
const tenantUser = requireTenant("tenant_user");

/**
 * The attachment download is a plain browser navigation (only that way does
 * `Content-Disposition: attachment` trigger a save-as), which cannot carry
 * the `X-Restow-Tenant` header the web UI otherwise sends when a provider
 * admin has switched into a customer tenant client-side; the tenant id may
 * therefore also arrive as the `tenant` query parameter, exactly like the
 * restore download (restore/routes.ts `tenantUserForDownload`). Registered on
 * its own route instead of the router-wide `tenantUser` above, which reads
 * the header only.
 */
const tenantUserForAttachmentDownload: MiddlewareHandler<TenantEnv> = async (c, next) => {
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

export function viewerOf(c: Context<TenantEnv>): Viewer {
  const user = c.get("user");
  return { role: c.get("role"), userId: user.id, email: user.email };
}

function readerOf(c: Context<TenantEnv>): SnapshotReader {
  return { ...viewerOf(c), ip: clientIp(c) };
}

// Static segments are registered before `/:id/...` so they never match as ids.

snapshotsRoutes.get("/objects", tenantUser, async (c) => {
  const query = parseOrProblem(listObjectsQuerySchema, c.req.query());
  return c.json({ items: await listObjects(db, c.get("tenantId"), viewerOf(c), query) });
});

snapshotsRoutes.get("/objects/:id/versions", tenantUser, async (c) => {
  const { id } = parseOrProblem(uuidParamSchema, c.req.param());
  const query = parseOrProblem(versionsQuerySchema, c.req.query());
  return c.json(await listVersions(db, c.get("tenantId"), readerOf(c), id, query));
});

snapshotsRoutes.get("/search", tenantUser, async (c) => {
  const query = parseOrProblem(searchQuerySchema, c.req.query());
  return c.json(await search(db, c.get("tenantId"), readerOf(c), query));
});

snapshotsRoutes.get("/", tenantUser, async (c) => {
  const query = parseOrProblem(listSnapshotsQuerySchema, c.req.query());
  return c.json({ items: await listSnapshots(db, c.get("tenantId"), viewerOf(c), query) });
});

snapshotsRoutes.get("/:id/tree", tenantUser, async (c) => {
  const { id } = parseOrProblem(uuidParamSchema, c.req.param());
  const query = parseOrProblem(treeQuerySchema, c.req.query());
  return c.json(await listTree(db, c.get("tenantId"), readerOf(c), id, query));
});

snapshotsRoutes.get("/:snapshotId/entries/:entryId/preview", tenantUser, async (c) => {
  const { snapshotId, entryId } = parseOrProblem(snapshotEntryParamSchema, c.req.param());
  return c.json(await previewMailEntry(db, c.get("tenantId"), readerOf(c), snapshotId, entryId));
});

snapshotsRoutes.get(
  "/:snapshotId/entries/:entryId/attachments/:attachmentId",
  tenantUserForAttachmentDownload,
  async (c) => {
    const { snapshotId, entryId, attachmentId } = parseOrProblem(
      attachmentParamSchema,
      c.req.param(),
    );
    const attachment = await openAttachmentDownload(
      db,
      c.get("tenantId"),
      readerOf(c),
      snapshotId,
      entryId,
      attachmentId,
    );
    return c.body(new Uint8Array(attachment.content), 200, {
      // service.ts already forces application/octet-stream for a content type
      // or file extension a browser would render (html, svg, xml).
      "content-type": attachment.contentType,
      "content-length": String(attachment.content.length),
      "content-disposition": contentDisposition(attachment.filename),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
  },
);
