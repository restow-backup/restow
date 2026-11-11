import {
  measureRepositoryBytes,
  pveRunCredentialLive,
  type StorageBackend,
  secretMatchesHash,
} from "@restow/core";
import { pveGuests, pveRuns, storageGenerationSql, tenants } from "@restow/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import {
  buildRunResticRoute,
  processLocalLocks,
  type RunResticAccess,
  type RunResticResolution,
} from "../../lib/restic-run-route.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { authFailures } from "../endpoints/agent-auth.js";
import { admitUpload } from "../run-size/guards.js";
import { runSizeGuards } from "../run-size/instance.js";
import { auditPve, PVE_AUDIT_ACTIONS } from "./audit.js";
import { PVE_RESTIC_PATH } from "./meta.js";
import { guestRepositoryPrefix, storageSwitchedDuringRun } from "./repository.js";
import { searchedTargets, storeTarget, type TenantChunkStore, tenantChunkStore } from "./store.js";

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
      startedAt: pveRuns.startedAt,
      tokenHash: pveRuns.resticTokenHash,
      expiresAt: pveRuns.resticExpiresAt,
      storageTarget: pveRuns.storageTarget,
      repositoryPrefix: pveGuests.repositoryPrefix,
      tenantStatus: tenants.status,
      generation: sql<string>`${storageGenerationSql(sql`${pveRuns.tenantId}`)}`,
    })
    .from(pveRuns)
    .innerJoin(tenants, eq(tenants.id, pveRuns.tenantId))
    .leftJoin(pveGuests, eq(pveGuests.id, pveRuns.guestId))
    .where(eq(pveRuns.id, credentials.runId))
    .limit(1);
  const ok =
    run?.tokenHash !== undefined &&
    run.tokenHash !== null &&
    secretMatchesHash(credentials.token, run.tokenHash);
  if (!run || !ok || run.guestId !== guestId) {
    return { ok: false, reason: "invalid" };
  }
  // The credential lives as long as its open run (at most 48 hours), not 24 hours from its
  // issue: a first backup of a large container may well take longer than a day.
  if (!pveRunCredentialLive(run, now) || run.tenantStatus !== "active") {
    return { ok: false, reason: "expired" };
  }
  // A backup stopped in the UI, or a run that has ended: restic fails at its next write (a node
  // without cancel orders), but may still release the lock it holds on the way out. Otherwise
  // the lock stays until it is stale and blocks the check and the retention of the repository.
  let closing = run.status !== "running" || run.cancelRequestedAt !== null;
  // The store of the tenant's current storage generation: a change of the primary is seen at
  // the next request, not when a cache runs out.
  const store = await tenantChunkStore(run.tenantId, Date.now(), run.generation ?? undefined);
  // The prefix the guest's current chain lies under (a fresh one on write-once storage).
  const prefix = guestRepositoryPrefix({ id: guestId, repositoryPrefix: run.repositoryPrefix });
  // Every request of a run goes to the one target its credential was issued for
  // (docs/STORAGE.md, "Runs and storage changes"). A backup whose target stopped being the
  // primary gets 403 for every write (restic takes it as final) instead of writing the rest of
  // its backup elsewhere.
  const pinned = run.storageTarget ? storeTarget(store, run.storageTarget) : null;
  let refuseWrites: ReturnType<typeof storageSwitchedDuringRun> | undefined;
  let storage: StorageBackend;
  if (run.kind === "backup") {
    if (run.storageTarget && run.storageTarget !== store.primaryTarget) {
      refuseWrites = storageSwitchedDuringRun(403);
      closing = true;
    }
    // A run from before 0.5.0 has no target recorded: the primary, as it always was.
    storage = pinned ?? store.write.primary;
  } else {
    storage = pinned ?? (await readingBackend(run.id, store, prefix));
  }
  return {
    ok: true,
    access: {
      tenantId: run.tenantId,
      runId: run.id,
      runKind: run.kind,
      principal: closing ? "closing" : "agent",
      prefix,
      storage,
      ...(refuseWrites ? { refuseWrites } : {}),
    },
  };
}

/** The target a restore run from before 0.5.0 (no target recorded) reads from, found once per run. */
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
  for (const target of await searchedTargets(store)) {
    if (await target.backend.head(`${prefix}config`).catch(() => null)) {
      found = target.backend;
      break;
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
  /** The repository's prefix (`guestRepositoryPrefix`); the guest's default when absent. */
  prefix?: string;
}

/** Measurements in progress, one per guest: concurrent uploads wait for the same listing. */
const measuring = new Map<string, Promise<number>>();

function measureOnce(guest: GuestKey, storage: StorageBackend): Promise<number> {
  const pending = measuring.get(guest.guestId);
  if (pending) {
    return pending;
  }
  const measured = (async () => {
    const bytes = await measureRepositoryBytes(
      storage,
      guest.prefix ?? guestRepositoryPrefix({ id: guest.guestId, repositoryPrefix: null }),
    );
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

/** The size guard of a container's backup run (features/run-size/guards.ts). */
function guestRunGuard(access: RunResticAccess, guestId: string) {
  return runSizeGuards.forRun({
    tenantId: access.tenantId,
    kind: "pve_guest",
    objectId: guestId,
    runId: access.runId,
    storage: access.storage,
  });
}

export const pveResticRoutes = buildRunResticRoute({
  basePath: PVE_RESTIC_PATH,
  param: "guestId",
  realm: "restow-pve",
  resolve: resolvePveRunCredential,
  locks: (access) => runLocks(access.runId),
  // The size and space guard of backup runs (#99): a container's backup run.
  admitUpload: (access, guestId, declared, resource) =>
    admitUpload(guestRunGuard(access, guestId), declared, resource),
  onAllowed: async (access, guestId, bytes, action) => {
    if (action === "write" && access.principal === "agent" && access.runKind === "backup") {
      guestRunGuard(access, guestId).record(bytes);
    }
    // The accounting never fails the upload itself.
    await addGuestUsage(
      { tenantId: access.tenantId, guestId, prefix: access.prefix },
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
