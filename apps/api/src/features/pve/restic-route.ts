import {
  type ResticLockRegistry,
  handleResticRequest,
  parseBasicAuthorization,
  secretMatchesHash,
} from "@restow/core";
import { pveRuns, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, providerDb } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { isUuid } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { authFailures } from "../endpoints/agent-auth.js";
import { PVE_AUDIT_ACTIONS, auditPve } from "./audit.js";
import { PVE_RESTIC_PATH } from "./meta.js";
import { guestRepositoryPrefix } from "./runs.js";
import { tenantChunkStore } from "./store.js";

/**
 * /agent/pve/restic/:guestId: the restic REST backend of one container's
 * repository (docs/PROXMOX.md 2.5). The credential is per run (`runId` and a
 * token that expires with it), handed to the container backup through files
 * only the container's mapped root can read; a node holds no long-lived
 * restic credential. The principal is append-only, as for the endpoint
 * agent: it reads and adds, it never deletes or overwrites a backup.
 * Retention, check and restore tests run on the server.
 */
export const pveResticRoutes = new Hono();

/** Lock files a run wrote (process-local; restic removes its own lock at the end). */
const runLocks = new Map<string, Set<string>>();

function lockRegistry(runId: string): ResticLockRegistry {
  const own = runLocks.get(runId) ?? new Set<string>();
  runLocks.set(runId, own);
  if (runLocks.size > 1000) {
    runLocks.delete(runLocks.keys().next().value as string);
  }
  return {
    isOwn: async (name) => own.has(name),
    created: async (name) => {
      own.add(name);
    },
    removed: async (name) => {
      own.delete(name);
    },
  };
}

pveResticRoutes.all("/:guestId/*", async (c) => {
  const guestId = c.req.param("guestId");
  const now = Date.now();
  const key = clientIp(c) ?? "unknown";
  if (authFailures.isBlocked(key, now)) {
    throw new ProblemError(429, "Too many requests", { type: "urn:restow:problem:rate-limited" });
  }
  const credentials = parseBasicAuthorization(c.req.header("authorization"));
  const deny = () => {
    authFailures.record(key, now);
    c.header("www-authenticate", 'Basic realm="restow-pve"');
    return new ProblemError(401, "Unauthorized", { detail: "The run credential is not valid." });
  };
  if (!credentials || !isUuid(credentials.username) || !isUuid(guestId)) {
    throw deny();
  }
  const [run] = await providerDb
    .select({
      id: pveRuns.id,
      tenantId: pveRuns.tenantId,
      guestId: pveRuns.guestId,
      status: pveRuns.status,
      tokenHash: pveRuns.resticTokenHash,
      expiresAt: pveRuns.resticExpiresAt,
      tenantStatus: tenants.status,
    })
    .from(pveRuns)
    .innerJoin(tenants, eq(tenants.id, pveRuns.tenantId))
    .where(eq(pveRuns.id, credentials.username))
    .limit(1);
  const ok =
    run?.tokenHash !== undefined &&
    run.tokenHash !== null &&
    secretMatchesHash(credentials.password, run.tokenHash);
  if (!run || !ok || run.guestId !== guestId) {
    throw deny();
  }
  if (
    run.status !== "running" ||
    !run.expiresAt ||
    run.expiresAt.getTime() < now ||
    run.tenantStatus !== "active"
  ) {
    throw new ProblemError(401, "Credential expired", {
      detail: "The run of this credential has ended.",
    });
  }
  const store = await tenantChunkStore(run.tenantId);
  const url = new URL(c.req.url);
  const base = `${PVE_RESTIC_PATH}/${guestId}`;
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : "/";
  return handleResticRequest(c.req.raw, {
    storage: store.write.primary,
    prefix: guestRepositoryPrefix(guestId),
    principal: "agent",
    path,
    query: url.searchParams,
    locks: lockRegistry(run.id),
    onDenied: ({ action, resource, reason }) => {
      const type =
        resource.kind === "object" || resource.kind === "list" ? resource.type : resource.kind;
      void auditPve(db, {
        tenantId: run.tenantId,
        actor: { label: `pve-run:${run.id}`, userId: null, ip: clientIp(c) },
        action: PVE_AUDIT_ACTIONS.denied,
        target: guestId,
        targetType: "pve_guest",
        details: { action, type, reason, method: c.req.method },
      }).catch(() => undefined);
    },
  });
});
