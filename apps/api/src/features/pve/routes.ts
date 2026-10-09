import { type Context, Hono } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  announcedAgentVersion,
  readInstallScript,
  readReleaseKey,
  renderInstallScript,
} from "../endpoints/distribution.js";
import { instanceUrl } from "../endpoints/instance-url.js";
import type { PveActor } from "./audit.js";
import {
  assignJobSchema,
  backupNowSchema,
  createTokenSchema,
  idParamSchema,
  jobSchema,
  restoreSchema,
} from "./schemas.js";
import {
  assignJob,
  backupNow,
  createEnrollmentToken,
  deleteJob,
  guestDetail,
  overview,
  requestVerify,
  restoreSnapshot,
  revokeNode,
  saveJob,
} from "./service.js";

/**
 * /api/v1/pve: VMs and containers of Proxmox VE, for tenant admins
 * (docs/PVE.md). Every change is audited.
 *
 *   GET    /                                 clusters with nodes, guests, jobs
 *   POST   /tokens                           a one-time enrollment token with the node command
 *                                             (optionally bound to an existing PVE API token)
 *   POST   /nodes/:id/revoke                 refuse a node from now on
 *   GET    /guests/:id                       a guest with its restore points and runs
 *   POST   /guests/:id/backup                back up now (optionally a verify read)
 *   PUT    /guests/:id/job                   put the guest into a job (or none)
 *   POST   /snapshots/:id/restore            restore as a new guest into the restore pool
 *   POST   /snapshots/:id/verify             read a sample of the restore point back now
 *   POST   /jobs, PATCH /jobs/:id, DELETE /jobs/:id
 */
export const pveRoutes = new Hono<TenantEnv>();

const admin = requireTenant("tenant_admin");

function actorOf(c: Context<TenantEnv>): PveActor {
  const user = c.get("user");
  return { label: user.email, userId: user.id, ip: clientIp(c) };
}

pveRoutes.get("/", admin, async (c) => c.json(await overview(db, c.get("tenantId"))));

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

pveRoutes.get("/guests/:id", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  return c.json(await guestDetail(db, c.get("tenantId"), id));
});

pveRoutes.post("/guests/:id/backup", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, backupNowSchema);
  return c.json(await backupNow(db, c.get("tenantId"), id, input, actorOf(c)), 202);
});

pveRoutes.put("/guests/:id/job", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const { jobId } = await parseJsonBody(c.req, assignJobSchema);
  await assignJob(db, c.get("tenantId"), id, jobId, actorOf(c));
  return c.body(null, 204);
});

pveRoutes.post("/snapshots/:id/restore", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, restoreSchema);
  return c.json(await restoreSnapshot(db, c.get("tenantId"), id, input, actorOf(c)), 202);
});

pveRoutes.post("/snapshots/:id/verify", admin, async (c) => {
  const { id } = parseOrProblem(idParamSchema, c.req.param());
  await requestVerify(db, c.get("tenantId"), id, actorOf(c));
  return c.body(null, 202);
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
