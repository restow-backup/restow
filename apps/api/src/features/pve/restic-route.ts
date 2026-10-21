import { measureRepositoryBytes, type StorageBackend, secretMatchesHash } from "@restow/core";
import { pveGuests, pveRuns, tenants } from "@restow/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import {
  buildRunResticRoute,
  processLocalLocks,
  type RunResticResolution,
} from "../../lib/restic-run-route.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { authFailures } from "../endpoints/agent-auth.js";
import { auditPve, PVE_AUDIT_ACTIONS } from "./audit.js";
import { PVE_RESTIC_PATH } from "./meta.js";
import { guestRepositoryPrefix } from "./repository.js";
import { type TenantChunkStore, tenantChunkStore } from "./store.js";

/**
 * /agent/pve/restic/:guestId: the restic REST backend of one container's
 * repository (docs/PROXMOX.md 2.5). The credential is per run (`runId` and a
 * token that expires with it), handed to the container backup through files
 * only the container's mapped root can read; a node holds no long-lived
 * restic credential. The principal is append-only, as for the endpoint
 * agent: it reads and adds, it never deletes or overwrites a backup. Once the
 * run was stopped or has ended, the credential (until it expires) only opens
 * the repository and releases the run's own lock files (the `closing`
 * principal); every other request is refused and audited.
 * Retention, check and restore tests run on the server.
 *
 * Built on the run-scoped route builder shared with file shares
 * (lib/restic-run-route.ts, docs/FILESHARES.md 5.3); the lock registry stays
 * process-local, as it was.
 *
 * The bytes the repository takes (`pve_guests.repository_bytes`, counted in the
 * tenant's stored bytes) are measured once, at the first upload after they were
 * unknown, then counted with every upload and deletion; the worker measures
 * them again after a prune. The repository may live on NFS: a view never
 * measures.
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
      kind: pveRuns.kind,
      status: pveRuns.status,
      cancelRequestedAt: pveRuns.cancelRequestedAt,
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
  if (!run.expiresAt || run.expiresAt.getTime() < now || run.tenantStatus !== "active") {
    return { ok: false, reason: "expired" };
  }
  // A backup stopped in the UI, or a run that has ended: restic fails at its next write (a node
  // without cancel orders), but may still release the lock it holds on the way out. Otherwise
  // the lock stays until it is stale and blocks the check and the retention of the repository.
  const closing = run.status !== "running" || run.cancelRequestedAt !== null;
  const store = await tenantChunkStore(run.tenantId);
  return {
    ok: true,
    access: {
      tenantId: run.tenantId,
      runId: run.id,
      principal: closing ? "closing" : "agent",
      prefix: guestRepositoryPrefix(guestId),
      // A backup writes to the primary only (its credential made sure the repository is
      // there, repository.ts); a restore reads from whichever target holds the repository,
      // a retired primary included.
      storage:
        run.kind === "backup"
          ? store.write.primary
          : await readingBackend(run.id, store, guestRepositoryPrefix(guestId)),
    },
  };
}

/** The target a restore run reads from, found once per run (bounded). */
const readingBackends = new Map<string, StorageBackend>();

async function readingBackend(
  runId: string,
  store: TenantChunkStore,
  prefix: string,
): Promise<StorageBackend> {
  const known = readingBackends.get(runId);
  if (known) {
    return known;
  }
  let found = store.write.primary;
  if (!(await store.write.primary.head(`${prefix}config`).catch(() => null))) {
    for (const other of store.read.copies) {
      if (await other.head(`${prefix}config`).catch(() => null)) {
        found = other;
        break;
      }
    }
  }
  if (readingBackends.size > 1000) {
    readingBackends.clear();
  }
  readingBackends.set(runId, found);
  return found;
}

export interface GuestKey {
  tenantId: string;
  guestId: string;
}

/** Measurements in progress, one per guest: concurrent uploads wait for the same listing. */
const measuring = new Map<string, Promise<number>>();

function measureOnce(guest: GuestKey, storage: StorageBackend): Promise<number> {
  const pending = measuring.get(guest.guestId);
  if (pending) {
    return pending;
  }
  const measured = (async () => {
    const bytes = await measureRepositoryBytes(storage, guestRepositoryPrefix(guest.guestId));
    await withTenantTx(db, guest.tenantId, (tx) =>
      tx
        .update(pveGuests)
        .set({ repositoryBytes: bytes, repositoryMeasuredAt: new Date() })
        .where(and(eq(pveGuests.id, guest.guestId), isNull(pveGuests.repositoryBytes))),
    );
    return bytes;
  })().finally(() => measuring.delete(guest.guestId));
  measuring.set(guest.guestId, measured);
  return measured;
}

/**
 * Count the bytes an upload added (or a deletion freed). While the size is unknown (a
 * repository from before 0.4.1), an upload measures the repository once instead, the
 * new file included.
 */
export async function addGuestUsage(
  guest: GuestKey,
  storage: StorageBackend,
  action: string,
  bytes: number,
): Promise<void> {
  const delta = action === "write" ? bytes : action === "delete" ? -bytes : 0;
  if (delta === 0) {
    return;
  }
  const counted = await withTenantTx(db, guest.tenantId, (tx) =>
    tx
      .update(pveGuests)
      .set({ repositoryBytes: sql`greatest(0, ${pveGuests.repositoryBytes} + ${delta})` })
      .where(and(eq(pveGuests.id, guest.guestId), isNotNull(pveGuests.repositoryBytes)))
      .returning({ id: pveGuests.id }),
  );
  if (counted.length === 0 && action === "write") {
    await measureOnce(guest, storage);
  }
}

/** Lock files a run wrote (process-local; restic removes its own lock at the end). */
const runLocks = processLocalLocks();

export const pveResticRoutes = buildRunResticRoute({
  basePath: PVE_RESTIC_PATH,
  param: "guestId",
  realm: "restow-pve",
  resolve: resolvePveRunCredential,
  locks: (access) => runLocks(access.runId),
  onAllowed: async (access, guestId, bytes, action) => {
    // The accounting never fails the upload itself.
    await addGuestUsage(
      { tenantId: access.tenantId, guestId },
      access.storage,
      action,
      bytes,
    ).catch(() => undefined);
  },
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
