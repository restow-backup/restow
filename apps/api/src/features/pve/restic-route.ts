import { secretMatchesHash } from "@restow/core";
import { pveRuns, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import {
  type RunResticResolution,
  buildRunResticRoute,
  processLocalLocks,
} from "../../lib/restic-run-route.js";
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
 *
 * Built on the run-scoped route builder shared with file shares
 * (lib/restic-run-route.ts, docs/FILESHARES.md 5.3); the lock registry stays
 * process-local, as it was.
 */

/** The credential of a container backup run, checked against `pve_runs`. */
export async function resolvePveRunCredential(
  credentials: { runId: string; token: string },
  guestId: string,
  now: number,
): Promise<RunResticResolution> {
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
    .where(eq(pveRuns.id, credentials.runId))
    .limit(1);
  const ok =
    run?.tokenHash !== undefined &&
    run.tokenHash !== null &&
    secretMatchesHash(credentials.token, run.tokenHash);
  if (!run || !ok || run.guestId !== guestId) {
    return { ok: false, reason: "invalid" };
  }
  if (
    run.status !== "running" ||
    !run.expiresAt ||
    run.expiresAt.getTime() < now ||
    run.tenantStatus !== "active"
  ) {
    return { ok: false, reason: "expired" };
  }
  const store = await tenantChunkStore(run.tenantId);
  return {
    ok: true,
    access: {
      tenantId: run.tenantId,
      runId: run.id,
      principal: "agent",
      prefix: guestRepositoryPrefix(guestId),
      storage: store.write.primary,
    },
  };
}

/** Lock files a run wrote (process-local; restic removes its own lock at the end). */
const runLocks = processLocalLocks();

export const pveResticRoutes = buildRunResticRoute({
  basePath: PVE_RESTIC_PATH,
  param: "guestId",
  realm: "restow-pve",
  resolve: resolvePveRunCredential,
  locks: (access) => runLocks(access.runId),
  failures: authFailures,
  audit: (access, guestId, denial) => {
    void auditPve(db, {
      tenantId: access.tenantId,
      actor: { label: `pve-run:${access.runId}`, userId: null, ip: denial.ip },
      action: PVE_AUDIT_ACTIONS.denied,
      target: guestId,
      targetType: "pve_guest",
      details: {
        action: denial.action,
        type: denial.type,
        reason: denial.reason,
        method: denial.method,
      },
    }).catch(() => undefined);
  },
});
