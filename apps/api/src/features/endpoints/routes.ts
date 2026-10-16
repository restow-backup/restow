import { Readable } from "node:stream";
import { endpointPrefix } from "@restow/core";
import { endpoints } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { providerRoleSatisfies } from "../../lib/provider-access.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { isTenantAdmin } from "../../middleware/rbac.js";
import {
  assertProviderRoute,
  authenticate,
  requireTenant,
  resolveTenantAccess,
  TENANT_HEADER,
  type TenantEnv,
} from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { resticRestorePointImmutability } from "../storage/immutability.js";
import { getTenantAgentPolicy, updateTenantAgentPolicy } from "./agent-policy.js";
import type { EndpointActor } from "./audit.js";
import { instanceUrl } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import {
  agentPolicyLevelSchema,
  agentUpdatesSchema,
  browseQuerySchema,
  createDownloadSchema,
  createTaskSchema,
  createTokenSchema,
  downloadParamSchema,
  endpointIdParamSchema,
  listEndpointsQuerySchema,
  listRunsQuerySchema,
  listTokensQuerySchema,
  MAX_DOWNLOAD_BODY_BYTES,
  runParamSchema,
  snapshotImmutabilityParamSchema,
  tokenIdParamSchema,
  updateEndpointSchema,
} from "./schemas.js";
import {
  browseSnapshot,
  createEnrollmentToken,
  createTask,
  getAgentUpdates,
  getEndpoint,
  getRun,
  listEndpoints,
  listEnrollmentTokens,
  listRuns,
  listSnapshots,
  openDownload,
  prepareDownload,
  requestRestoreTest,
  requestUninstall,
  resumeMachineUpdates,
  revealRepositoryPassword,
  revokeEndpoint,
  revokeEnrollmentToken,
  setAgentUpdates,
  updateEndpoint,
} from "./service.js";

/**
 * /api/v1/endpoints: servers and clients backed up by the Restow agent, for
 * tenant admins (docs/AGENT.md). Everything an admin changes and every read
 * of backed-up files is audited.
 *
 * Restore operators (`tenant_restore`, middleware/rbac.ts) use the file
 * restore: they list the machines, open one (without its hook texts), its
 * restore points, browse them, download files and restore files onto the
 * machine (POST /:id/tasks with `kind: "restore"`). Everything else, backing
 * up now included, stays with the admins.
 *
 *   GET    /?profile=                           servers and clients with status and readiness
 *   GET    /tokens?state=valid|all              enrollment tokens: the valid ones (default), or every state
 *   POST   /tokens                              create a one-time token; shown once, with the commands
 *   DELETE /tokens/:tokenId                     revoke an unused token
 *   GET    /agent-updates                       the tenant's pause of automatic agent updates, and the machines paused on their own
 *   PUT    /agent-updates                       pause or resume them for the tenant (also with no machine yet)
 *   DELETE /agent-updates/machines/:id          lift one machine's own pause
 *   GET    /agent-policy                        the tenant's level of the agent policy, the
 *                                               installation's it inherits (with its locks), the result
 *   PUT    /agent-policy                        replace the tenant's level (not what is locked); writes
 *                                               every machine's configuration that changes
 *   GET    /:id                                 detail: config, runs, waiting and recent tasks, reports
 *                                               (hook texts only for who may change the configuration)
 *   PATCH  /:id                                 name, paths, excludes, schedule, hooks, bandwidth, retention,
 *                                               the person of the directory the machine is assigned to
 *   POST   /:id/revoke                          refuse the endpoint from now on
 *   POST   /:id/uninstall                       have the agent remove itself, then revoke
 *   POST   /:id/tasks                           back up now, or restore into a new folder on the endpoint
 *   POST   /:id/restore-test                    read the samples back and compare their hashes now
 *   POST   /:id/repository-password             the restic password, for a restore without Restow (audited)
 *   GET    /:id/runs?limit=                     recent runs
 *   GET    /:id/runs/:runId                     one run with its log tail and errors
 *   GET    /:id/snapshots                       restic snapshots of the repository
 *   GET    /:id/browse?snapshotId=&path=&cursor=  one page of a folder of a snapshot
 *   POST   /:id/downloads                       check selected files and folders, prepare a ZIP (paths in the body)
 *   GET    /:id/downloads/:downloadId           start the prepared ZIP: streamed, audited first, once
 *
 * Setting or changing a hook (it runs as root on the machine) and showing the
 * repository password (it opens every backup of the machine without Restow)
 * need a recent sign-in on top of the role (lib/recent-sign-in.ts): an older
 * session gets 403 `urn:restow:problem:recent-sign-in-required`, and the web
 * app asks the person to confirm it is them and repeats the action. Removing
 * every hook needs none (service.ts, hookChangeNeedsRecentSignIn).
 */
export const endpointsRoutes = new Hono<TenantEnv>();

const admin = requireTenant("tenant_admin");
/** The file restore: restore operators and the administrators above them. */
const restorer = requireTenant("tenant_restore");

/**
 * Starting a prepared download is a plain browser navigation, which cannot
 * carry the `X-Restow-Tenant` header; the tenant id may therefore also arrive
 * as the `tenant` query parameter (like the restore download). Otherwise
 * identical to requireTenant("tenant_restore"). The prepared download itself is
 * bound to the person who created it, so the address alone opens nothing.
 */
const restorerForDownload: MiddlewareHandler<TenantEnv> = async (c, next) => {
  const state = await authenticate(c.req.raw.headers);
  assertProviderRoute(c, state);
  const selector = c.req.header(TENANT_HEADER) ?? c.req.query("tenant");
  const { tenant, role } = await resolveTenantAccess(state, selector, "tenant_restore");
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

/**
 * Whether the viewer may change an endpoint's configuration, and so read its
 * hook texts: a tenant admin, or a provider member from "Administrator" on.
 * A restore operator may not.
 */
export function mayConfigure(c: Context<TenantEnv>): boolean {
  const access = c.get("providerAccess");
  if (c.get("isProviderAdmin") && access) {
    return providerRoleSatisfies(access.role, "administrator");
  }
  const role = c.get("role");
  return role !== undefined && isTenantAdmin(role);
}

function actorOf(c: Context<TenantEnv>): EndpointActor {
  const user = c.get("user");
  return { label: user.email, userId: user.id, ip: clientIp(c) };
}

endpointsRoutes.get("/", restorer, async (c) => {
  const query = parseOrProblem(listEndpointsQuerySchema, c.req.query());
  return c.json(await listEndpoints(db, c.get("tenantId"), query));
});

// Static paths first, so "tokens" is never read as an endpoint id.
endpointsRoutes.get("/tokens", admin, async (c) => {
  const query = parseOrProblem(listTokensQuerySchema, c.req.query());
  return c.json(await listEnrollmentTokens(db, c.get("tenantId"), query));
});

endpointsRoutes.post("/tokens", admin, async (c) => {
  const input = await parseJsonBody(c.req, createTokenSchema);
  const created = await createEnrollmentToken(
    db,
    c.get("tenantId"),
    input,
    actorOf(c),
    await instanceUrl(c),
  );
  // The response carries the token: nothing may keep a copy.
  c.header("cache-control", "no-store");
  return c.json(created, 201);
});

endpointsRoutes.get("/agent-updates", admin, async (c) => {
  return c.json(await getAgentUpdates(db, c.get("tenantId")));
});

endpointsRoutes.put("/agent-updates", admin, async (c) => {
  const { paused, resumeMachines } = await parseJsonBody(c.req, agentUpdatesSchema);
  return c.json(
    await setAgentUpdates(db, c.get("tenantId"), paused, actorOf(c), { resumeMachines }),
  );
});

endpointsRoutes.get("/agent-policy", admin, async (c) => {
  return c.json(await getTenantAgentPolicy(db, c.get("tenantId")));
});

endpointsRoutes.put("/agent-policy", admin, async (c) => {
  const input = await parseJsonBody(c.req, agentPolicyLevelSchema);
  return c.json(await updateTenantAgentPolicy(db, c.get("tenantId"), input, actorOf(c)));
});

endpointsRoutes.delete("/agent-updates/machines/:id", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await resumeMachineUpdates(db, c.get("tenantId"), id, actorOf(c)));
});

endpointsRoutes.delete("/tokens/:tokenId", admin, async (c) => {
  const { tokenId } = parseOrProblem(tokenIdParamSchema, c.req.param());
  await revokeEnrollmentToken(db, c.get("tenantId"), tokenId, actorOf(c));
  return c.body(null, 204);
});

endpointsRoutes.get("/:id", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const instance = await instanceUrl(c);
  return c.json(
    await getEndpoint(db, c.get("tenantId"), id, instance.url, { revealHooks: mayConfigure(c) }),
  );
});

endpointsRoutes.patch("/:id", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, updateEndpointSchema);
  return c.json(
    await updateEndpoint(db, c.get("tenantId"), id, input, actorOf(c), {
      confirmHookChange: () => assertRecentSignIn(c.get("auth").session),
    }),
  );
});

endpointsRoutes.post("/:id/revoke", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  await revokeEndpoint(db, c.get("tenantId"), id, actorOf(c));
  return c.body(null, 204);
});

endpointsRoutes.post("/:id/uninstall", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await requestUninstall(db, c.get("tenantId"), id, actorOf(c)), 202);
});

endpointsRoutes.post("/:id/tasks", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, createTaskSchema);
  // A restore operator restores files; backing up now is the admins'.
  if (input.kind !== "restore" && !isTenantAdmin(c.get("role"))) {
    throw new ProblemError(403, "Insufficient role", {
      detail: "Backing up now requires the tenant_admin role.",
      extensions: { requiredRole: "tenant_admin", role: c.get("role") },
    });
  }
  const result = await createTask(db, c.get("tenantId"), id, input, actorOf(c));
  return c.json(result, result.alreadyQueued ? 200 : 202);
});

endpointsRoutes.post("/:id/restore-test", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await requestRestoreTest(db, c.get("tenantId"), id, actorOf(c)), 202);
});

endpointsRoutes.post("/:id/repository-password", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  assertRecentSignIn(c.get("auth").session);
  const key = await revealRepositoryPassword(db, c.get("tenantId"), id, actorOf(c));
  // The response carries the password: nothing may keep a copy.
  c.header("cache-control", "no-store");
  return c.json(key);
});

endpointsRoutes.get("/:id/runs", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const { limit } = parseOrProblem(listRunsQuerySchema, c.req.query());
  return c.json(await listRuns(db, c.get("tenantId"), id, limit));
});

endpointsRoutes.get("/:id/runs/:runId", admin, async (c) => {
  const { id, runId } = parseOrProblem(runParamSchema, c.req.param());
  return c.json(await getRun(db, c.get("tenantId"), id, runId));
});

endpointsRoutes.get("/:id/snapshots", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await listSnapshots(db, c.get("tenantId"), id));
});

/** Whether a restore point is immutable, as the storage reports it for its snapshot file. */
endpointsRoutes.get("/:id/snapshots/:snapshotId/immutability", restorer, async (c) => {
  const { id, snapshotId } = parseOrProblem(snapshotImmutabilityParamSchema, c.req.param());
  const tenantId = c.get("tenantId");
  const [row] = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ id: endpoints.id })
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, id)))
      .limit(1),
  );
  if (!row) {
    throw new ProblemError(404, "Endpoint not found");
  }
  return c.json(await resticRestorePointImmutability(db, tenantId, endpointPrefix(id), snapshotId));
});

endpointsRoutes.get("/:id/browse", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const query = parseOrProblem(browseQuerySchema, c.req.query());
  return c.json(
    await browseSnapshot(db, c.get("tenantId"), id, query, actorOf(c), c.req.raw.signal),
  );
});

/**
 * Read the body of a download request with a cap: a selection of ten thousand
 * paths fits, anything much larger is refused before it is parsed.
 */
async function readDownloadBody(c: Context<TenantEnv>): Promise<unknown> {
  const tooLarge = () =>
    new ProblemError(413, "Selection too large", {
      type: ENDPOINT_PROBLEMS.downloadTooLarge,
      detail:
        "The selected paths are too many or too long for one download. Select fewer items, or a parent folder.",
    });
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BODY_BYTES) {
    throw tooLarge();
  }
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_DOWNLOAD_BODY_BYTES) {
    throw tooLarge();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

endpointsRoutes.post("/:id/downloads", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = parseOrProblem(createDownloadSchema, await readDownloadBody(c));
  const prepared = await prepareDownload(
    db,
    c.get("tenantId"),
    id,
    input,
    actorOf(c),
    c.req.raw.signal,
  );
  c.header("cache-control", "no-store");
  return c.json(prepared, 201);
});

endpointsRoutes.get("/:id/downloads/:downloadId", restorerForDownload, async (c) => {
  // Hono answers a HEAD request with the GET handler; a probe must not use up the download.
  if (c.req.method === "HEAD") {
    return c.body(null, 405, { allow: "GET" });
  }
  const { id, downloadId } = parseOrProblem(downloadParamSchema, c.req.param());
  const download = await openDownload(
    db,
    c.get("tenantId"),
    id,
    downloadId,
    actorOf(c),
    c.req.raw.signal,
  );
  const fileName = download.fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "files.zip";
  return new Response(Readable.toWeb(download.stream) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
