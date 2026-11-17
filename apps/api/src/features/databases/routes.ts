import { type Context, Hono } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { requireTenant, type TenantEnv } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { connectionHealth, databaseSizeHistory, healthRangeSchema } from "./health.js";
import {
  createConnectionSchema,
  idParamSchema,
  probeParamSchema,
  testConnectionSchema,
  updateConnectionSchema,
} from "./schemas.js";
import {
  createConnection,
  type DatabaseContext,
  deleteConnection,
  getConnection,
  getDatabase,
  getProbe,
  listConnections,
  listDatabases,
  listRunners,
  listSuggestions,
  testConnection,
  testStoredConnection,
  updateConnection,
} from "./service.js";

/**
 * /api/v1/databases: the module "Databases" (docs/DATABASES.md 9), stage D1. Creating, changing,
 * testing and deleting is for administrators; reading also for restore operators. Credentials
 * are written, never read: an answer says `credential: "set"`.
 *
 *   GET    /                                     the tenant's databases (rating, reachability)
 *   GET    /suggestions                          instances the agents' inventories found (3.4)
 *   GET    /runners                              agents that can run connections
 *   GET    /connections                          the connections
 *   POST   /connections                          save a connection from a finished test
 *   POST   /connections/test                     test settings without saving them
 *   GET    /connections/test/:probeId            the state of a test (an agent's runs a while)
 *   GET    /connections/:id                      one connection with its databases
 *   PATCH  /connections/:id                      change it; confirm a new certificate or instance
 *   DELETE /connections/:id                      delete it with its credentials
 *   POST   /connections/:id/test                 test the stored connection
 *   GET    /connections/:id/health?from&to       its health history (D2: availability, response
 *                                                time, connections, events)
 *   GET    /:id                                  one database
 *   GET    /:id/health?from&to                   its size day by day (D2)
 */
export const databasesRoutes = new Hono<TenantEnv>();

const admin = requireTenant("tenant_admin");
const reader = requireTenant("tenant_restore");

function contextOf(c: Context<TenantEnv>): DatabaseContext {
  const user = c.get("user");
  return {
    actor: { label: user.email, userId: user.id, ip: clientIp(c) },
    isProviderAdmin: c.get("isProviderAdmin"),
  };
}

databasesRoutes.get("/", reader, async (c) => c.json(await listDatabases(db, c.get("tenantId"))));

databasesRoutes.get("/suggestions", admin, async (c) =>
  c.json(await listSuggestions(db, c.get("tenantId"))),
);

databasesRoutes.get("/runners", admin, async (c) =>
  c.json(await listRunners(db, c.get("tenantId"))),
);

databasesRoutes.get("/connections", reader, async (c) =>
  c.json(await listConnections(db, c.get("tenantId"))),
);

databasesRoutes.post("/connections", admin, async (c) => {
  const input = await parseJsonBody(c.req, createConnectionSchema);
  return c.json(await createConnection(db, c.get("tenantId"), input, contextOf(c)), 201);
});

databasesRoutes.post("/connections/test", admin, async (c) => {
  const input = await parseJsonBody(c.req, testConnectionSchema);
  const probe = await testConnection(db, c.get("tenantId"), input, contextOf(c));
  return c.json(probe, probe.status === "pending" ? 202 : 200);
});

databasesRoutes.get("/connections/test/:probeId", admin, async (c) => {
  const { probeId } = parseOrProblem(probeParamSchema, c.req.param());
  return c.json(await getProbe(db, c.get("tenantId"), probeId, {}));
});

databasesRoutes.get("/connections/:id", reader, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await getConnection(db, c.get("tenantId"), id));
});

databasesRoutes.patch("/connections/:id", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, updateConnectionSchema);
  return c.json(await updateConnection(db, c.get("tenantId"), id, input, contextOf(c)));
});

databasesRoutes.delete("/connections/:id", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  await deleteConnection(db, c.get("tenantId"), id, contextOf(c));
  return c.body(null, 204);
});

databasesRoutes.post("/connections/:id/test", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const probe = await testStoredConnection(db, c.get("tenantId"), id, contextOf(c));
  return c.json(probe, probe.status === "pending" ? 202 : 200);
});

databasesRoutes.get("/connections/:id/health", reader, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const range = parseOrProblem(healthRangeSchema, c.req.query());
  return c.json(await connectionHealth(db, c.get("tenantId"), id, range));
});

databasesRoutes.get("/:id/health", reader, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const range = parseOrProblem(healthRangeSchema, c.req.query());
  return c.json(await databaseSizeHistory(db, c.get("tenantId"), id, range));
});

databasesRoutes.get("/:id", reader, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await getDatabase(db, c.get("tenantId"), id));
});
