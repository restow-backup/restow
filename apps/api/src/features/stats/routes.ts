import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db, providerDb } from "../../db.js";
import { requireFeature } from "../../lib/features.js";
import { requestLanguage } from "../../lib/language.js";
import { clientIp } from "../../lib/request.js";
import {
  type SessionEnv,
  type SessionVariables,
  type TenantEnv,
  requireProviderAdmin,
  requireTenant,
} from "../../middleware/session.js";
import { PDF_CONTENT_TYPE } from "../../reports/render.js";
import { parseOrProblem } from "../../schemas.js";
import { contentDisposition } from "../restore/headers.js";
import { exportQuerySchema, reportQuerySchema, statsQuerySchema } from "./schemas.js";
import {
  type StatsActor,
  type StatsDeps,
  type StatsScope,
  exportDataset,
  generateReport,
  loadStats,
} from "./service.js";

/**
 * /api/v1/stats — statistics for the stats page, as CSV per dataset, and as
 * a PDF report.
 *
 * `?scope=tenant` (the default) covers the tenant named by X-Restow-Tenant
 * and needs the tenant_admin role (provider admins may enter any tenant);
 * `?scope=provider` adds up every tenant and needs a provider admin while
 * `stats.allTenants` is on (lib/features.ts). The scope decides which
 * of the shared session middlewares authenticates the request, so both paths
 * get the same session, role and cross-site checks as every other route.
 *
 * The CSV export and the PDF report are audited; the JSON figures are not
 * (service.ts explains why).
 */

type StatsEnv = { Variables: SessionVariables & { statsScope: StatsScope } };

const tenantAdmin = requireTenant("tenant_admin");

/** Authenticate for the scope the request names, and expose it as `statsScope`. */
export const requireStatsScope: MiddlewareHandler<StatsEnv> = async (c, next) => {
  if (c.req.query("scope") === "provider") {
    // The shared middlewares are typed for their own context; they only set
    // the session variables this context declares as well.
    await requireProviderAdmin(c as unknown as Context<SessionEnv>, async () => {
      await requireFeature(providerDb, "stats.allTenants");
      c.set("statsScope", { kind: "provider" });
      await next();
    });
    return;
  }
  const tenantContext = c as unknown as Context<TenantEnv>;
  await tenantAdmin(tenantContext, async () => {
    const tenant = tenantContext.get("tenant");
    c.set("statsScope", {
      kind: "tenant",
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    });
    await next();
  });
};

function actorOf(c: Context<StatsEnv>): StatsActor {
  const user = c.get("user");
  return { userId: user.id, email: user.email, ip: clientIp(c) };
}

const deps: StatsDeps = { db, providerDb };

export const statsRoutes = new Hono<StatsEnv>();

statsRoutes.use("*", requireStatsScope);

statsRoutes.get("/", async (c) => {
  const query = parseOrProblem(statsQuerySchema, c.req.query());
  const { stats } = await loadStats(deps, c.get("statsScope"), query);
  return c.json(stats);
});

statsRoutes.get("/export.csv", async (c) => {
  const query = parseOrProblem(exportQuerySchema, c.req.query());
  const file = await exportDataset(deps, c.get("statsScope"), query, actorOf(c));
  return c.body(file.body, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": contentDisposition(file.fileName),
    "cache-control": "private, no-store",
  });
});

statsRoutes.get("/report.pdf", async (c) => {
  const query = parseOrProblem(reportQuerySchema, c.req.query());
  const language = query.lang ?? requestLanguage(c);
  const report = await generateReport(deps, c.get("statsScope"), query, language, actorOf(c));
  return c.body(new Uint8Array(report.pdf), 200, {
    "content-type": PDF_CONTENT_TYPE,
    "content-length": String(report.pdf.length),
    "content-disposition": contentDisposition(report.fileName),
    "cache-control": "private, no-store",
  });
});
