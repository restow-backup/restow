import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { requireTenant, type TenantEnv } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import type { ArchiveActor } from "../archive/service.js";
import {
  captureMailboxesQuerySchema,
  captureObjectParamSchema,
  holdBodySchema,
  holdSourceParamSchema,
} from "./schemas.js";
import { captureMailboxes, captureStatus, listHolds, requestResync, setHold } from "./service.js";

/**
 * /api/v1/archive/capture — archive capture beyond Exchange journaling (docs/ARCHIVE.md
 * "Erfassungswege"): the state of the capture ways and the hold confirmation of the
 * Microsoft 365 sources.
 *
 *   GET  /                           every way: available (edition), streams by status,
 *                                    how mail is noticed, counts of 24 h and 7 days,
 *                                    backfill progress
 *   GET  /mailboxes                  the capture streams, filtered, keyset-paginated
 *   POST /mailboxes/:objectId/resync a full catch-up of the mailbox's streams (audited;
 *                                    needs `archive.mailboxCapture`)
 *   GET  /holds                      the hold confirmation per Microsoft 365 source
 *   PUT  /holds/:sourceId            confirm or withdraw it (audited)
 *
 * The capture itself runs in the worker (apps/worker/src/archive-capture).
 */
export interface ArchiveCaptureRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
  /** The installation pool the feature gates read (tests); defaults to the API's. */
  installation?: DbExecutor;
}

function actorOf(c: Context<TenantEnv>): ArchiveActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildArchiveCaptureRoutes(deps: ArchiveCaptureRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();

  routes.get("/", deps.requireAdmin, async (c) => {
    return c.json(await captureStatus(deps.db, c.get("tenantId"), deps.installation));
  });

  routes.get("/mailboxes", deps.requireAdmin, async (c) => {
    const query = parseOrProblem(captureMailboxesQuerySchema, c.req.query());
    return c.json(await captureMailboxes(deps.db, c.get("tenantId"), query));
  });

  routes.post("/mailboxes/:objectId/resync", deps.requireAdmin, async (c) => {
    const { objectId } = parseOrProblem(captureObjectParamSchema, c.req.param());
    return c.json(
      await requestResync(deps.db, c.get("tenantId"), objectId, actorOf(c), deps.installation),
      202,
    );
  });

  routes.get("/holds", deps.requireAdmin, async (c) => {
    return c.json({ items: await listHolds(deps.db, c.get("tenantId")) });
  });

  routes.put("/holds/:sourceId", deps.requireAdmin, async (c) => {
    const { sourceId } = parseOrProblem(holdSourceParamSchema, c.req.param());
    const body = await parseJsonBody(c.req, holdBodySchema);
    return c.json(await setHold(deps.db, c.get("tenantId"), sourceId, body.status, actorOf(c)));
  });

  return routes;
}

/** Mounted under /api/v1 by app.ts. */
export const archiveCaptureMountPath = "/archive/capture";

export const archiveCaptureRoutes = buildArchiveCaptureRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
});
