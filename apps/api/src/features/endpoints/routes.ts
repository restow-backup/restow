import { Readable } from "node:stream";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { providerRoleSatisfies } from "../../lib/provider-access.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import {
  TENANT_HEADER,
  type TenantEnv,
  assertProviderRoute,
  authenticate,
  requireTenant,
  resolveTenantAccess,
} from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import type { EndpointActor } from "./audit.js";
import { instanceUrl } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import {
  MAX_DOWNLOAD_BODY_BYTES,
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
  runParamSchema,
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
 *   GET    /?profile=                           servers and clients with status and readiness
 *   GET    /tokens?state=valid|all              enrollment tokens: the valid ones (default), or every state
 *   POST   /tokens                              create a one-time token; shown once, with the commands
 *   DELETE /tokens/:tokenId                     revoke an unused token
 *   GET    /agent-updates                       the tenant's pause of automatic agent updates, and the machines paused on their own
 *   PUT    /agent-updates                       pause or resume them for the tenant (also with no machine yet)
 *   DELETE /agent-updates/machines/:id          lift one machine's own pause
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

/**
 * Starting a prepared download is a plain browser navigation, which cannot
 * carry the `X-Restow-Tenant` header; the tenant id may therefore also arrive
 * as the `tenant` query parameter (like the restore download). Otherwise
 * identical to requireTenant("tenant_admin"). The prepared download itself is
 * bound to the admin who created it, so the address alone opens nothing.
 */
const adminForDownload: MiddlewareHandler<TenantEnv> = async (c, next) => {
  const state = await authenticate(c.req.raw.headers);
  assertProviderRoute(c, state);
  const selector = c.req.header(TENANT_HEADER) ?? c.req.query("tenant");
  const { tenant, role } = await resolveTenantAccess(state, selector, "tenant_admin");
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
 */
export function mayConfigure(c: Context<TenantEnv>): boolean {
  const access = c.get("providerAccess");
  if (c.get("isProviderAdmin") && access) {
    return providerRoleSatisfies(access.role, "administrator");
  }
  return true;
}

function actorOf(c: Context<TenantEnv>): EndpointActor {
  const user = c.get("user");
  return { label: user.email, userId: user.id, ip: clientIp(c) };
}

endpointsRoutes.get("/", admin, async (c) => {
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

endpointsRoutes.delete("/agent-updates/machines/:id", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await resumeMachineUpdates(db, c.get("tenantId"), id, actorOf(c)));
});

endpointsRoutes.delete("/tokens/:tokenId", admin, async (c) => {
  const { tokenId } = parseOrProblem(tokenIdParamSchema, c.req.param());
  await revokeEnrollmentToken(db, c.get("tenantId"), tokenId, actorOf(c));
  return c.body(null, 204);
});

endpointsRoutes.get("/:id", admin, async (c) => {
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

endpointsRoutes.post("/:id/tasks", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, createTaskSchema);
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

endpointsRoutes.get("/:id/snapshots", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await listSnapshots(db, c.get("tenantId"), id));
});

endpointsRoutes.get("/:id/browse", admin, async (c) => {
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

endpointsRoutes.post("/:id/downloads", admin, async (c) => {
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

endpointsRoutes.get("/:id/downloads/:downloadId", adminForDownload, async (c) => {
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
