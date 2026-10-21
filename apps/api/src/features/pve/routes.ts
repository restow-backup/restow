import { Readable } from "node:stream";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
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
import {
  announcedAgentVersion,
  readInstallScript,
  readReleaseKey,
  renderInstallScript,
} from "../endpoints/distribution.js";
import { instanceUrl } from "../endpoints/instance-url.js";
import { ENDPOINT_PROBLEMS } from "../endpoints/problems.js";
import { MAX_DOWNLOAD_BODY_BYTES } from "../endpoints/schemas.js";
import { pveActivity } from "./activity.js";
import type { PveActor } from "./audit.js";
import { requestBootTest } from "./boot-tests.js";
import {
  cancelGuestBackup,
  cancelQueuedBackups,
  requestNodeUpdate,
  setNodeQueuePaused,
} from "./cancel.js";
import { browseContainerFiles, openContainerDownload, prepareContainerDownload } from "./files.js";
import { resetGuestRepository } from "./repository.js";
import {
  assignJobSchema,
  backupNowSchema,
  createFilesDownloadSchema,
  createTokenSchema,
  filesDownloadParamSchema,
  filesQuerySchema,
  idParamSchema,
  jobSchema,
  resetRepositorySchema,
  restoreSchema,
  restowServerSchema,
} from "./schemas.js";
import {
  assignJob,
  backupNow,
  createEnrollmentToken,
  deleteJob,
  guestDetail,
  overview,
  requestGuestVerify,
  requestUnverifiedVerify,
  requestVerify,
  restoreSnapshot,
  revokeNode,
  saveJob,
  setRestowServerFlag,
} from "./service.js";

/**
 * /api/v1/pve: VMs and containers of Proxmox VE, for tenant admins
 * (docs/PVE.md). Every change is audited, and so is every read of a
 * container's backed-up files (file restore, #62; features/pve/files.ts).
 *
 * Restore operators (`tenant_restore`, middleware/rbac.ts) use the file
 * restore: they read the overview and a guest with its restore points, browse
 * a restore point's files and download them. Everything else (jobs, backing
 * up, verify and boot tests, putting a guest back as a whole, nodes and
 * tokens) stays with the admins.
 *
 *   GET    /                                 clusters with nodes, guests, jobs
 *   GET    /activity                         the guests that back up now and how many wait
 *   POST   /tokens                           a one-time enrollment token with the node command
 *                                             (optionally bound to an existing PVE API token)
 *   POST   /nodes/:id/revoke                 refuse a node from now on
 *   POST   /nodes/:id/queue/pause|resume     hand the node no backup until resumed
 *   POST   /nodes/:id/queue/cancel           withdraw every queued backup of the node
 *   POST   /nodes/:id/update                 the node installs the offered release when idle
 *   POST   /queue/cancel                     withdraw every queued backup of the tenant
 *   GET    /guests/:id                       a guest with its restore points and runs
 *   POST   /guests/:id/backup                back up now (optionally a verify read); the Restow
 *                                             server's own VM only with `confirmSelfBackup`
 *   POST   /guests/:id/cancel                stop its running backup, withdraw its queued ones
 *   PUT    /guests/:id/job                   put the guest into a job (or none); the same
 *   POST   /guests/:id/repository/reset      a container: begin a new backup chain ({ confirmName },
 *                                            recent sign-in); its restore points become unavailable
 *   PUT    /guests/:id/restow-server         mark the guest as the Restow server's own VM, or not
 *   POST   /guests/:id/verify                check the guest's newest restore point now
 *   POST   /verify-unverified                check every guest's unchecked newest restore point
 *   POST   /snapshots/:id/restore            restore as a new guest into the restore pool
 *   POST   /snapshots/:id/verify             read a sample of the restore point back now
 *   POST   /snapshots/:id/boot-test          boot the restore point on its node now (boot test)
 *   GET    /snapshots/:id/files?path=&cursor=  one page of a folder of a container restore point
 *   POST   /snapshots/:id/downloads          check selected files and folders, prepare a ZIP
 *   GET    /snapshots/:id/downloads/:downloadId  start the prepared ZIP: streamed, audited first, once
 *   POST   /jobs, PATCH /jobs/:id, DELETE /jobs/:id
 */
export const pveRoutes = new Hono<TenantEnv>();

const admin = requireTenant("tenant_admin");
/** The file restore: restore operators and the administrators above them. */
const restorer = requireTenant("tenant_restore");

/**
 * Starting a prepared download is a plain browser navigation, which cannot
 * carry the `X-Restow-Tenant` header; the tenant id may also arrive as the
 * `tenant` query parameter (as for the machines' downloads). Otherwise
 * identical to requireTenant("tenant_restore"). The download itself is bound to
 * the person who prepared it, so the address alone opens nothing.
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

function actorOf(c: Context<TenantEnv>): PveActor {
  const user = c.get("user");
  return { label: user.email, userId: user.id, ip: clientIp(c) };
}

pveRoutes.get("/", restorer, async (c) => c.json(await overview(db, c.get("tenantId"))));
pveRoutes.get("/activity", restorer, async (c) => c.json(await pveActivity(db, c.get("tenantId"))));

pveRoutes.post("/tokens", admin, async (c) => {
  const input = await parseJsonBody(c.req, createTokenSchema);
  const created = await createEnrollmentToken(
    db,
    c.get("tenantId"),
    actorOf(c),
    await instanceUrl(c),
    input,
  );
  c.header("cache-control", "no-store");
  return c.json(created, 201);
});

pveRoutes.post("/nodes/:id/revoke", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  await revokeNode(db, c.get("tenantId"), id, actorOf(c));
  return c.body(null, 204);
});

pveRoutes.post("/nodes/:id/queue/pause", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await setNodeQueuePaused(db, c.get("tenantId"), id, true, actorOf(c)));
});

pveRoutes.post("/nodes/:id/queue/resume", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await setNodeQueuePaused(db, c.get("tenantId"), id, false, actorOf(c)));
});

pveRoutes.post("/nodes/:id/queue/cancel", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await cancelQueuedBackups(db, c.get("tenantId"), id, actorOf(c)));
});

pveRoutes.post("/nodes/:id/update", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await requestNodeUpdate(db, c.get("tenantId"), id, actorOf(c)), 202);
});

pveRoutes.post("/queue/cancel", admin, async (c) =>
  c.json(await cancelQueuedBackups(db, c.get("tenantId"), null, actorOf(c))),
);

pveRoutes.post("/guests/:id/cancel", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await cancelGuestBackup(db, c.get("tenantId"), id, actorOf(c)), 202);
});

pveRoutes.get("/guests/:id", restorer, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await guestDetail(db, c.get("tenantId"), id));
});

pveRoutes.post("/guests/:id/backup", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, backupNowSchema);
  return c.json(await backupNow(db, c.get("tenantId"), id, input, actorOf(c)), 202);
});

pveRoutes.post("/guests/:id/repository/reset", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const { confirmName } = await parseJsonBody(c.req, resetRepositorySchema);
  assertRecentSignIn(c.get("auth").session);
  return c.json(await resetGuestRepository(db, c.get("tenantId"), id, confirmName, actorOf(c)));
});

pveRoutes.put("/guests/:id/job", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const { jobId, confirmSelfBackup } = await parseJsonBody(c.req, assignJobSchema);
  await assignJob(db, c.get("tenantId"), id, jobId, actorOf(c), { confirmSelfBackup });
  return c.body(null, 204);
});

pveRoutes.post("/snapshots/:id/restore", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, restoreSchema);
  return c.json(await restoreSnapshot(db, c.get("tenantId"), id, input, actorOf(c)), 202);
});

pveRoutes.post("/guests/:id/verify", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await requestGuestVerify(db, c.get("tenantId"), id, actorOf(c)), 202);
});

pveRoutes.post("/verify-unverified", admin, async (c) => {
  return c.json(await requestUnverifiedVerify(db, c.get("tenantId"), actorOf(c)), 202);
});

pveRoutes.put("/guests/:id/restow-server", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const { flagged } = await parseJsonBody(c.req, restowServerSchema);
  await setRestowServerFlag(db, c.get("tenantId"), id, flagged, actorOf(c));
  return c.body(null, 204);
});

pveRoutes.post("/snapshots/:id/verify", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  await requestVerify(db, c.get("tenantId"), id, actorOf(c));
  return c.body(null, 202);
});

pveRoutes.post("/snapshots/:id/boot-test", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await requestBootTest(db, c.get("tenantId"), id, actorOf(c)), 202);
});

pveRoutes.get("/snapshots/:id/files", restorer, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const query = parseOrProblem(filesQuerySchema, c.req.query());
  return c.json(
    await browseContainerFiles(db, c.get("tenantId"), id, query, actorOf(c), c.req.raw.signal),
  );
});

/** The body of a download request, read with a cap (thousands of paths fit). */
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

pveRoutes.post("/snapshots/:id/downloads", restorer, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = parseOrProblem(createFilesDownloadSchema, await readDownloadBody(c));
  const prepared = await prepareContainerDownload(
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

pveRoutes.get("/snapshots/:id/downloads/:downloadId", restorerForDownload, async (c) => {
  // Hono answers a HEAD request with the GET handler; a probe must not use up the download.
  if (c.req.method === "HEAD") {
    return c.body(null, 405, { allow: "GET" });
  }
  const { id, downloadId } = parseOrProblem(filesDownloadParamSchema, c.req.param());
  const download = await openContainerDownload(
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

pveRoutes.post("/jobs", admin, async (c) => {
  const input = await parseJsonBody(c.req, jobSchema);
  return c.json(await saveJob(db, c.get("tenantId"), null, input, actorOf(c)), 201);
});

pveRoutes.patch("/jobs/:id", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, jobSchema);
  return c.json(await saveJob(db, c.get("tenantId"), id, input, actorOf(c)));
});

pveRoutes.delete("/jobs/:id", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  await deleteJob(db, c.get("tenantId"), id, actorOf(c));
  return c.body(null, 204);
});

/**
 * GET /install/pve.sh: the node installer (agent/install/pve.sh), with the
 * instance address, the release version and the release signing key filled
 * in. No login, no secret in it (the command shown in Restow passes the
 * enrollment token in the environment).
 */
export async function pveInstallScript(c: Context): Promise<Response> {
  const template = await readInstallScript("pve.sh");
  if (template === null) {
    throw new ProblemError(404, "Install script not available", {
      detail: "This installation does not ship the node installer for Proxmox VE.",
    });
  }
  const instance = await instanceUrl(c);
  let body: string;
  try {
    body = renderInstallScript(
      template,
      instance.url,
      await announcedAgentVersion(),
      await readReleaseKey(),
    );
  } catch {
    throw new ProblemError(503, "Instance address unusable", {
      detail: "The public address of this installation cannot be used in an install script.",
    });
  }
  return c.body(body, 200, {
    "content-type": "text/x-shellscript; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
}
