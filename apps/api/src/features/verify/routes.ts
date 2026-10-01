import { type Context, Hono } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  listReportsQuerySchema,
  reportIdParamSchema,
  runScrubSchema,
  runVerifySchema,
} from "./schemas.js";
import {
  type VerifyActor,
  getReport,
  listReports,
  readinessOverview,
  runScrubNow,
  runVerify,
} from "./service.js";

/**
 * /api/v1/verify — recovery readiness for tenant admins: the rating per
 * object, report history and details, storage integrity, and "check now".
 */

export const verifyRoutes = new Hono<TenantEnv>();

verifyRoutes.use("*", requireTenant("tenant_admin"));

function actorOf(c: Context<TenantEnv>): VerifyActor {
  const user = c.get("user");
  return { userId: user.id, email: user.email, ip: clientIp(c) };
}

verifyRoutes.get("/latest", async (c) => {
  return c.json(await readinessOverview(db, c.get("tenantId")));
});

verifyRoutes.get("/reports", async (c) => {
  const query = parseOrProblem(listReportsQuerySchema, c.req.query());
  return c.json(await listReports(db, c.get("tenantId"), query));
});

verifyRoutes.get("/reports/:id", async (c) => {
  const { id } = parseOrProblem(reportIdParamSchema, c.req.param());
  return c.json(await getReport(db, c.get("tenantId"), id, actorOf(c)));
});

verifyRoutes.post("/", async (c) => {
  const input = await parseJsonBody(c.req, runVerifySchema);
  return c.json(await runVerify(db, c.get("tenantId"), input, actorOf(c)), 202);
});

verifyRoutes.post("/scrub", async (c) => {
  const input = await parseJsonBody(c.req, runScrubSchema);
  return c.json(await runScrubNow(db, c.get("tenantId"), input, actorOf(c)), 202);
});
