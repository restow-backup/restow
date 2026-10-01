import { type Context, Hono } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  accountsRequestSchema,
  bulkProtectionSchema,
  csvImportSchema,
  groupSearchQuerySchema,
  objectCredentialSchema,
  objectParamSchema,
  objectsQuerySchema,
  protectionOverrideSchema,
  rulesSchema,
  sourceParamSchema,
  syncRequestSchema,
  userParamSchema,
} from "./schemas.js";
import {
  type Actor,
  bulkSetProtection,
  deleteAccount,
  importAccounts,
  importAccountsCsv,
  listObjects,
  listSources,
  requestSync,
  searchSourceGroups,
  setObjectCredential,
  setObjectProtection,
  setUserProtection,
  testObjectCredential,
  updateRules,
} from "./service.js";

/**
 * /api/v1/directory — the protection directory of the active tenant.
 *
 *   GET    /sources                            sources with rules, sync state and counts
 *   PUT    /sources/:sourceId/rules            replace the rules (queues a sync)
 *   GET    /sources/:sourceId/groups?search=   groups of the M365 tenant, for the rules editor
 *   POST   /sources/:sourceId/sync             sync now ({ full } enumerates everything)
 *   POST   /sources/:sourceId/accounts         add IMAP accounts ({ accounts, dryRun })
 *   POST   /sources/:sourceId/accounts/import  add IMAP accounts from CSV ({ csv, dryRun })
 *   GET    /objects                            protected objects: filter, search, paginate
 *   POST   /objects/:id/protection             include / exclude / reset one object
 *   POST   /objects/:id/credential              set/replace an IMAP account's own password
 *   POST   /objects/:id/credential/test         try that account's login now
 *   DELETE /objects/:id                        remove an IMAP account without backups
 *   POST   /sources/:sourceId/protection/bulk  include / exclude / reset many objects of a source
 *   POST   /users/:userId/protection           include / exclude / reset all objects of a user
 *
 * Everything requires tenant-admin access (provider admins qualify); every
 * change is audited with the acting user and client IP.
 */

export const directoryRoutes = new Hono<TenantEnv>();

const tenantAdmin = requireTenant("tenant_admin");

function actorOf(c: Context<TenantEnv>): Actor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

// --- Sources, rules, sync ----------------------------------------------------------

directoryRoutes.get("/sources", tenantAdmin, async (c) => {
  return c.json({ items: await listSources(db, c.get("tenantId")) });
});

directoryRoutes.put("/sources/:sourceId/rules", tenantAdmin, async (c) => {
  const { sourceId } = parseOrProblem(sourceParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, rulesSchema);
  return c.json(await updateRules(db, c.get("tenantId"), sourceId, input, actorOf(c)));
});

directoryRoutes.get("/sources/:sourceId/groups", tenantAdmin, async (c) => {
  const { sourceId } = parseOrProblem(sourceParamSchema, c.req.param());
  const { search } = parseOrProblem(groupSearchQuerySchema, c.req.query());
  return c.json({ items: await searchSourceGroups(db, c.get("tenantId"), sourceId, search) });
});

directoryRoutes.post("/sources/:sourceId/sync", tenantAdmin, async (c) => {
  const { sourceId } = parseOrProblem(sourceParamSchema, c.req.param());
  const input = parseOrProblem(syncRequestSchema, await c.req.json().catch(() => ({})));
  return c.json(await requestSync(db, c.get("tenantId"), sourceId, input, actorOf(c)), 202);
});

// --- IMAP accounts -------------------------------------------------------------------

directoryRoutes.post("/sources/:sourceId/accounts", tenantAdmin, async (c) => {
  const { sourceId } = parseOrProblem(sourceParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, accountsRequestSchema);
  const outcome = await importAccounts(
    db,
    c.get("tenantId"),
    sourceId,
    input.accounts.map((account) => ({ line: null, ...account })),
    actorOf(c),
    { dryRun: input.dryRun },
  );
  return c.json(outcome, input.dryRun ? 200 : 201);
});

directoryRoutes.post("/sources/:sourceId/accounts/import", tenantAdmin, async (c) => {
  const { sourceId } = parseOrProblem(sourceParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, csvImportSchema);
  const outcome = await importAccountsCsv(db, c.get("tenantId"), sourceId, input.csv, actorOf(c), {
    dryRun: input.dryRun,
  });
  return c.json(outcome, input.dryRun ? 200 : 201);
});

// --- Protected objects ---------------------------------------------------------------

directoryRoutes.get("/objects", tenantAdmin, async (c) => {
  const query = parseOrProblem(objectsQuerySchema, c.req.query());
  return c.json(await listObjects(db, c.get("tenantId"), query));
});

directoryRoutes.post("/objects/:id/protection", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(objectParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, protectionOverrideSchema);
  return c.json(await setObjectProtection(db, c.get("tenantId"), id, input, actorOf(c)));
});

directoryRoutes.post("/objects/:id/credential", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(objectParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, objectCredentialSchema);
  return c.json(await setObjectCredential(db, c.get("tenantId"), id, input, actorOf(c)));
});

directoryRoutes.post("/objects/:id/credential/test", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(objectParamSchema, c.req.param());
  return c.json(await testObjectCredential(db, c.get("tenantId"), id, actorOf(c)));
});

directoryRoutes.delete("/objects/:id", tenantAdmin, async (c) => {
  const { id } = parseOrProblem(objectParamSchema, c.req.param());
  await deleteAccount(db, c.get("tenantId"), id, actorOf(c));
  return c.body(null, 204);
});

directoryRoutes.post("/sources/:sourceId/protection/bulk", tenantAdmin, async (c) => {
  const { sourceId } = parseOrProblem(sourceParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, bulkProtectionSchema);
  return c.json(await bulkSetProtection(db, c.get("tenantId"), sourceId, input, actorOf(c)));
});

directoryRoutes.post("/users/:userId/protection", tenantAdmin, async (c) => {
  const { userId } = parseOrProblem(userParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, protectionOverrideSchema);
  return c.json(await setUserProtection(db, c.get("tenantId"), userId, input, actorOf(c)));
});
