import { Readable } from "node:stream";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import {
  TENANT_HEADER,
  type TenantEnv,
  assertProviderRoute,
  authenticate,
  refuseApiKeys,
  requireProviderAdmin,
  requireTenant,
  resolveTenantAccess,
} from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import type { FileShareActor } from "./audit.js";
import {
  browseSnapshot,
  fileVersions,
  listSnapshots,
  openDownload,
  prepareDownload,
  searchCatalog,
} from "./browse.js";
import {
  MAX_DOWNLOAD_BODY_BYTES,
  approvalSchema,
  backupNowSchema,
  browseQuerySchema,
  createDownloadSchema,
  createShareSchema,
  deleteShareSchema,
  downloadParamSchema,
  idParamSchema,
  installationSettingsSchema,
  listQuerySchema,
  quotaSchema,
  restoreSchema,
  runItemsQuerySchema,
  runParamSchema,
  runsQuerySchema,
  searchQuerySchema,
  sourceQuerySchema,
  testConnectionSchema,
  updateShareSchema,
  versionsQuerySchema,
} from "./schemas.js";
import {
  type ShareContext,
  backupNow,
  cancelRun,
  createShare,
  getInstallationShareSettings,
  getRun,
  getShare,
  listRuns,
  listShareSource,
  listShares,
  purgeShare,
  reactivateShare,
  requestRestore,
  requestVerify,
  restoreTargets,
  retireShare,
  revealRepositoryPassword,
  setPrivateNetworkApproval,
  setShareQuota,
  tenantShareSettings,
  testStoredShare,
  testUnsavedShare,
  updateInstallationShareSettings,
  updateShare,
} from "./service.js";

/**
 * /api/v1/file-shares: SMB shares and NFS exports backed up from the server side
 * (docs/FILESHARES.md 9.1), for tenant admins; provider admins by their team role
 * (lib/provider-access.ts). Nothing here restarts the api or the worker. Every change, every
 * read of backed-up content and every restore is audited.
 *
 *   GET    /                                   shares with standing, readiness, last and active run
 *   POST   /                                   add a share (password sealed with the tenant key)
 *   GET    /settings                           what of the installation concerns the tenant's shares
 *   GET    /restore-targets                    shares of the tenant that allow restores
 *   POST   /test                               test settings that are not saved yet (runner probe)
 *   GET    /installation-settings              the installation settings (provider admins)
 *   PUT    /installation-settings              change them (private networks: owner)
 *   GET    /:id                                one share (never its password)
 *   PATCH  /:id                                change any field; `password` replaces the stored one
 *   POST   /:id/test                           test the stored settings
 *   GET    /:id/source?path=                   one folder of the live share (runner list)
 *   POST   /:id/backup                         back up now
 *   POST   /:id/retire, /:id/reactivate        stop protecting (backups kept) and back
 *   DELETE /:id                                delete the share's backups ({ confirmName }, recent sign-in)
 *   GET    /:id/runs, /:id/runs/:runId         runs, one run with its per-file items
 *   POST   /:id/runs/:runId/cancel
 *   GET    /:id/snapshots                      restore points
 *   GET    /:id/browse?snapshot=&path=         one folder of a restore point
 *   GET    /:id/search?q=&snapshot=            the catalog
 *   GET    /:id/versions?path=                 the versions of one file
 *   POST   /:id/downloads, GET /:id/downloads/:downloadId   ZIP
 *   POST   /:id/restores                       restore into this or another share
 *   POST   /:id/verify                         restore check now
 *   PUT    /:id/quota                          the storage budget (provider administrators)
 *   POST   /:id/repository-password            the restic password (recent sign-in)
 *   PUT    /:id/private-network-approval       approve or withdraw (provider admins)
 */
export const fileSharesRoutes = new Hono<TenantEnv>();

const admin = requireTenant("tenant_admin");

/** The prepared ZIP is started by a navigation, which names the tenant in the query. */
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

function actorOf(c: Context<TenantEnv>): FileShareActor {
  const user = c.get("user");
  return { label: user.email, userId: user.id, ip: clientIp(c) };
}

function contextOf(c: Context<TenantEnv>): ShareContext {
  const access = c.get("providerAccess");
  return {
    actor: actorOf(c),
    isProviderAdmin: c.get("isProviderAdmin"),
    providerRole: c.get("isProviderAdmin") && access ? access.role : null,
  };
}

async function readCappedJson(c: Context<TenantEnv>): Promise<unknown> {
  const tooLarge = () =>
    new ProblemError(413, "Selection too large", {
      detail:
        "The selected paths are too many or too long for one request. Select fewer items, or a parent folder.",
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

// Installation settings: provider admins (with every tenant), before the `/:id` routes.
fileSharesRoutes.get(
  "/installation-settings",
  refuseApiKeys,
  requireProviderAdmin as unknown as MiddlewareHandler<TenantEnv>,
  async (c) => c.json(await getInstallationShareSettings({})),
);

fileSharesRoutes.put(
  "/installation-settings",
  refuseApiKeys,
  requireProviderAdmin as unknown as MiddlewareHandler<TenantEnv>,
  async (c) => {
    const input = await parseJsonBody(c.req, installationSettingsSchema);
    return c.json(await updateInstallationShareSettings(input, contextOf(c)));
  },
);

fileSharesRoutes.get("/", admin, async (c) => {
  const query = parseOrProblem(listQuerySchema, c.req.query());
  return c.json(await listShares(db, c.get("tenantId"), query));
});

fileSharesRoutes.post("/", admin, async (c) => {
  const input = await parseJsonBody(c.req, createShareSchema);
  return c.json(await createShare(db, c.get("tenantId"), input, contextOf(c)), 201);
});

fileSharesRoutes.get("/settings", admin, async (c) =>
  c.json(await tenantShareSettings(c.get("tenantId"), {})),
);

fileSharesRoutes.get("/restore-targets", admin, async (c) =>
  c.json(await restoreTargets(db, c.get("tenantId"))),
);

fileSharesRoutes.post("/test", admin, async (c) => {
  const input = await parseJsonBody(c.req, testConnectionSchema);
  return c.json(await testUnsavedShare(db, c.get("tenantId"), input, contextOf(c)));
});

fileSharesRoutes.get("/:id", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await getShare(db, c.get("tenantId"), id));
});

fileSharesRoutes.patch("/:id", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, updateShareSchema);
  return c.json(await updateShare(db, c.get("tenantId"), id, input, contextOf(c)));
});

fileSharesRoutes.delete("/:id", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const { confirmName } = await parseJsonBody(c.req, deleteShareSchema);
  assertRecentSignIn(c.get("auth").session);
  return c.json(await purgeShare(db, c.get("tenantId"), id, confirmName, contextOf(c)), 202);
});

fileSharesRoutes.post("/:id/test", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await testStoredShare(db, c.get("tenantId"), id, contextOf(c)));
});

fileSharesRoutes.get("/:id/source", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const query = parseOrProblem(sourceQuerySchema, c.req.query());
  return c.json(await listShareSource(db, c.get("tenantId"), id, query, contextOf(c)));
});

fileSharesRoutes.post("/:id/backup", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const raw = await c.req.text();
  let body: unknown = {};
  try {
    body = raw.trim() ? (JSON.parse(raw) as unknown) : {};
  } catch {
    body = null;
  }
  const input = parseOrProblem(backupNowSchema, body);
  const result = await backupNow(db, c.get("tenantId"), id, input, contextOf(c));
  return c.json(result, result.alreadyQueued ? 200 : 202);
});

fileSharesRoutes.post("/:id/retire", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await retireShare(db, c.get("tenantId"), id, contextOf(c)));
});

fileSharesRoutes.post("/:id/reactivate", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await reactivateShare(db, c.get("tenantId"), id, contextOf(c)));
});

fileSharesRoutes.get("/:id/runs", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const query = parseOrProblem(runsQuerySchema, c.req.query());
  return c.json(await listRuns(db, c.get("tenantId"), id, query));
});

fileSharesRoutes.get("/:id/runs/:runId", admin, async (c) => {
  const { id, runId } = parseOrProblem(runParamSchema, c.req.param());
  const query = parseOrProblem(runItemsQuerySchema, c.req.query());
  return c.json(await getRun(db, c.get("tenantId"), id, runId, query));
});

fileSharesRoutes.post("/:id/runs/:runId/cancel", admin, async (c) => {
  const { id, runId } = parseOrProblem(runParamSchema, c.req.param());
  return c.json(await cancelRun(db, c.get("tenantId"), id, runId, contextOf(c)), 202);
});

fileSharesRoutes.get("/:id/snapshots", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await listSnapshots(db, c.get("tenantId"), id));
});

fileSharesRoutes.get("/:id/browse", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const query = parseOrProblem(browseQuerySchema, c.req.query());
  return c.json(
    await browseSnapshot(db, c.get("tenantId"), id, query, actorOf(c), c.req.raw.signal),
  );
});

fileSharesRoutes.get("/:id/search", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const query = parseOrProblem(searchQuerySchema, c.req.query());
  return c.json(await searchCatalog(db, c.get("tenantId"), id, query, actorOf(c)));
});

fileSharesRoutes.get("/:id/versions", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const { path } = parseOrProblem(versionsQuerySchema, c.req.query());
  return c.json(await fileVersions(db, c.get("tenantId"), id, path));
});

fileSharesRoutes.post("/:id/downloads", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = parseOrProblem(createDownloadSchema, await readCappedJson(c));
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

fileSharesRoutes.get("/:id/downloads/:downloadId", adminForDownload, async (c) => {
  // Hono answers HEAD with the GET handler; a probe must not use up the download.
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

fileSharesRoutes.post("/:id/restores", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = parseOrProblem(restoreSchema, await readCappedJson(c));
  return c.json(await requestRestore(db, c.get("tenantId"), id, input, contextOf(c)), 202);
});

fileSharesRoutes.post("/:id/verify", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await requestVerify(db, c.get("tenantId"), id, contextOf(c)), 202);
});

fileSharesRoutes.put("/:id/quota", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const { quotaGib } = await parseJsonBody(c.req, quotaSchema);
  return c.json(await setShareQuota(db, c.get("tenantId"), id, quotaGib, contextOf(c)));
});

fileSharesRoutes.post("/:id/repository-password", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  assertRecentSignIn(c.get("auth").session);
  const key = await revealRepositoryPassword(db, c.get("tenantId"), id, contextOf(c));
  c.header("cache-control", "no-store");
  return c.json(key);
});

fileSharesRoutes.put("/:id/private-network-approval", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  if (!c.get("isProviderAdmin")) {
    throw new ProblemError(403, "Provider admins only", {
      detail: "Only a provider admin approves a file share on a private network.",
    });
  }
  const { approved } = await parseJsonBody(c.req, approvalSchema);
  return c.json(await setPrivateNetworkApproval(db, c.get("tenantId"), id, approved, contextOf(c)));
});
