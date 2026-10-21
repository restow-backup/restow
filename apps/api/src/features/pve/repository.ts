import { randomBytes } from "node:crypto";
import {
  resticBinary,
  resticCacheBase,
  resticInit,
  type StorageBackend,
  sealEndpointPassword,
  withRepository,
} from "@restow/core";
import {
  type Database,
  PVE_REPOSITORY_CHAINS_KEPT,
  type PveGuest,
  type PveRepositoryChain,
  pveGuests,
  pveSnapshots,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../../db.js";
import { loadTenantDek, readSecret, storeSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { removeRepositoryObjects } from "../endpoints/repository.js";
import { type DestinationDeps, destinationRecord } from "../storage/destination.js";
import { auditPve, PVE_AUDIT_ACTIONS, type PveActor } from "./audit.js";
import { type TenantChunkStore, tenantChunkStore } from "./store.js";

/**
 * The restic repository of a container (docs/PVE.md, "Container repositories"): one per guest
 * under `pve-guests/<guest id>/` of the tenant's primary target. The server creates it (a node
 * is append-only and cannot) and hands every backup run a credential for it.
 *
 * Before a backup run gets its credential, the server makes sure the repository is really
 * there: `repository_ready_at` only says it was created once, not that it still exists on the
 * primary. When it is gone (the primary changed without it, or it was deleted) and no other
 * target of the tenant holds it, a new repository is created: a new backup chain begins, the
 * container's earlier restore points become `unavailable` (they cannot be restored or checked
 * any more), and the guest records the change, which its page and its history show. When
 * another target (a retired primary) still holds it, the backup is refused with a clear
 * message instead: a storage "move" brings it over, or an administrator resets the repository.
 */

export const PVE_REPOSITORY_PROBLEMS = {
  elsewhere: "urn:restow:problem:pve-repository-elsewhere",
  unreachable: "urn:restow:problem:pve-repository-unreachable",
  notContainer: "urn:restow:problem:pve-repository-not-container",
  confirmName: "urn:restow:problem:pve-repository-confirm-name",
  leftover: "urn:restow:problem:pve-repository-leftover",
} as const;

/** Container repositories lie under this prefix of the tenant's primary target. */
export function guestRepositoryPrefix(guestId: string): string {
  return `pve-guests/${guestId}/`;
}
export const PVE_REPOSITORY_SECRET_KIND = "pve_ct_repository";

/** Runs whose repository was already found on the primary (one check per run). */
const CHECKED_RUNS_MAX = 10_000;
const checkedRuns = new Set<string>();

function rememberChecked(runId: string): void {
  if (checkedRuns.size >= CHECKED_RUNS_MAX) {
    checkedRuns.clear();
  }
  checkedRuns.add(runId);
}

/** Forget which runs were checked (tests). */
export function forgetCheckedRuns(): void {
  checkedRuns.clear();
}

export interface RepositoryDeps {
  db?: Database;
  now?: () => Date;
  destination?: DestinationDeps;
}

/** Whether `key` exists on `backend`; a storage that does not answer is an error, not "missing". */
async function exists(backend: StorageBackend, key: string): Promise<boolean> {
  try {
    return (await backend.head(key)) !== null;
  } catch (error) {
    throw new ProblemError(503, "Storage not reachable", {
      type: PVE_REPOSITORY_PROBLEMS.unreachable,
      detail: `The storage target of this container's backups did not answer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/** Another target of the tenant (a retired primary, a copy) that holds the repository. */
async function heldElsewhere(store: TenantChunkStore, prefix: string): Promise<boolean> {
  for (const other of store.read.copies) {
    if (await other.head(`${prefix}config`).catch(() => null)) {
      return true;
    }
  }
  return false;
}

/**
 * Mark the container's restore points unavailable and record the new chain on the guest
 * (newest first, capped). The guest's last restore point and its last check are forgotten:
 * they belong to the chain before.
 */
export async function recordNewChain(
  tx: Transaction,
  guest: Pick<PveGuest, "id" | "repositoryChains">,
  chain: Omit<PveRepositoryChain, "unavailablePoints">,
  now: Date,
): Promise<PveRepositoryChain> {
  const marked = await tx
    .update(pveSnapshots)
    .set({ status: "unavailable", unavailableAt: now })
    .where(
      and(
        eq(pveSnapshots.guestId, guest.id),
        eq(pveSnapshots.kind, "ct"),
        eq(pveSnapshots.status, "active"),
      ),
    )
    .returning({ id: pveSnapshots.id });
  const record: PveRepositoryChain = { ...chain, unavailablePoints: marked.length };
  await tx
    .update(pveGuests)
    .set({
      repositoryChains: [record, ...(guest.repositoryChains ?? [])].slice(
        0,
        PVE_REPOSITORY_CHAINS_KEPT,
      ),
      lastSnapshotId: null,
      lastSuccessAt: null,
      lastVerifyAt: null,
      lastRestoreTestAt: null,
    })
    .where(eq(pveGuests.id, guest.id));
  return record;
}

/**
 * Create the repository on the primary with a new password. A repository left at the prefix
 * by an earlier chain (after a reset, or a creation that never got recorded) is removed first;
 * no active restore point refers to it.
 */
async function createRepository(
  database: Database,
  tenantId: string,
  guest: PveGuest,
  store: TenantChunkStore,
): Promise<string> {
  const prefix = guestRepositoryPrefix(guest.id);
  const primary = store.write.primary;
  if (await exists(primary, `${prefix}config`)) {
    const [active] = await withTenantTx(database, tenantId, (tx) =>
      tx
        .select({ id: pveSnapshots.id })
        .from(pveSnapshots)
        .where(
          and(
            eq(pveSnapshots.guestId, guest.id),
            eq(pveSnapshots.kind, "ct"),
            eq(pveSnapshots.status, "active"),
          ),
        )
        .limit(1),
    );
    if (active) {
      throw new ProblemError(409, "Repository state unclear", {
        type: PVE_REPOSITORY_PROBLEMS.leftover,
        detail:
          "The container has restore points, but its repository is not recorded as ready. Reset the repository on the guest page to begin a new backup chain.",
      });
    }
    await removeRepositoryObjects(primary, prefix);
  }
  const password = randomBytes(32).toString("base64url");
  const secret = await storeSecret(database, {
    tenantId,
    kind: PVE_REPOSITORY_SECRET_KIND,
    plaintext: password,
  });
  await withRepository(
    {
      storage: primary,
      prefix,
      repositoryPassword: password,
      repositoryKey: guest.id,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    },
    (session) => resticInit(session),
  );
  const dek = await withTenantTx(database, tenantId, (tx) => loadTenantDek(tx, tenantId));
  // Next to the repository, sealed with the tenant key: storage and master key restore without this database.
  await primary.put(
    `${prefix}restow-repository-password.json`,
    sealEndpointPassword({ tenantId, endpointId: guest.id, password, dek }),
  );
  await withTenantTx(database, tenantId, (tx) =>
    tx
      .update(pveGuests)
      .set({
        repositorySecretId: secret.id,
        repositoryReadyAt: new Date(),
        repositoryBytes: null,
        repositoryMeasuredAt: null,
      })
      .where(eq(pveGuests.id, guest.id)),
  );
  return password;
}

/**
 * The repository password of a container for a run, creating the repository when it does not
 * exist yet. `write` (a backup) also makes sure the repository is on the primary: missing
 * there and nowhere else, a new backup chain begins (see the module comment); held by another
 * target, the backup is refused. Reads (a restore) never create anything: the restic route
 * reads from whichever target holds the repository.
 */
export async function ensureGuestRepository(
  tenantId: string,
  guestId: string,
  run: { runId: string; write: boolean },
  deps: RepositoryDeps = {},
): Promise<string> {
  const database = deps.db ?? defaultDb;
  const now = deps.now ?? (() => new Date());
  const [guest] = await withTenantTx(database, tenantId, (tx) =>
    tx.select().from(pveGuests).where(eq(pveGuests.id, guestId)).limit(1),
  );
  if (!guest) {
    throw new ProblemError(404, "Guest not found", { detail: "Unknown guest." });
  }
  const store = await tenantChunkStore(tenantId);
  const prefix = guestRepositoryPrefix(guest.id);
  if (guest.repositorySecretId && guest.repositoryReadyAt) {
    const password = await readSecret(database, { id: guest.repositorySecretId, tenantId });
    if (password) {
      if (!run.write || checkedRuns.has(run.runId)) {
        return password;
      }
      if (await exists(store.write.primary, `${prefix}config`)) {
        rememberChecked(run.runId);
        return password;
      }
      if (await heldElsewhere(store, prefix)) {
        throw new ProblemError(409, "Repository on another storage target", {
          type: PVE_REPOSITORY_PROBLEMS.elsewhere,
          detail:
            'The repository of this container is not on the current primary storage target but on another target of this tenant (a previous primary). Move the backups to the primary (storage, replace the primary with "move"), or reset the repository on the guest page to begin a new backup chain.',
        });
      }
      // Gone: a new chain begins (below), and the guest says so.
      const password2 = await createRepository(database, tenantId, guest, store);
      const target = await destinationRecord(database, tenantId, deps.destination);
      const at = now();
      await withTenantTx(database, tenantId, async (tx) => {
        const recorded = await recordNewChain(
          tx,
          guest,
          { at: at.toISOString(), reason: "missing", target, actor: null },
          at,
        );
        await auditPve(tx, {
          tenantId,
          actor: { label: `pve-run:${run.runId}`, userId: null, ip: null },
          action: PVE_AUDIT_ACTIONS.repositoryReinitialized,
          target: guest.id,
          targetType: "pve_guest",
          details: {
            vmid: guest.vmid,
            reason: "missing",
            target: target.name,
            installationDefault: target.installationDefault,
            unavailablePoints: recorded.unavailablePoints,
            previousReadyAt: guest.repositoryReadyAt?.toISOString() ?? null,
            runId: run.runId,
          },
        });
      });
      rememberChecked(run.runId);
      return password2;
    }
  }
  const password = await createRepository(database, tenantId, guest, store);
  rememberChecked(run.runId);
  return password;
}

/**
 * Reset a container's repository (an administrator, typed confirmation and a recent sign-in
 * checked by the route): its restore points become unavailable at once, and the next backup
 * begins a new chain in a new repository. Whatever of the old repository is on the primary is
 * removed by that backup before it creates the new one (`createRepository`; immutable storage
 * keeps what it must); a retired target is never touched.
 */
export async function resetGuestRepository(
  database: Database,
  tenantId: string,
  guestId: string,
  confirmName: string,
  actor: PveActor,
  deps: RepositoryDeps = {},
): Promise<{ unavailablePoints: number }> {
  const at = (deps.now ?? (() => new Date()))();
  const target = await destinationRecord(database, tenantId, deps.destination);
  const result = await withTenantTx(database, tenantId, async (tx) => {
    const [guest] = await tx
      .select()
      .from(pveGuests)
      .where(eq(pveGuests.id, guestId))
      .for("update")
      .limit(1);
    if (!guest) {
      throw new ProblemError(404, "Guest not found");
    }
    if (guest.kind !== "ct") {
      throw new ProblemError(409, "Not a container", {
        type: PVE_REPOSITORY_PROBLEMS.notContainer,
        detail: "Only containers have a restic repository; a VM's disks lie in the chunk store.",
      });
    }
    const expected = guest.name ?? String(guest.vmid);
    if (confirmName.trim() !== expected) {
      throw new ProblemError(422, "Name does not match", {
        type: PVE_REPOSITORY_PROBLEMS.confirmName,
        detail: "Type the name of the guest exactly to reset its repository.",
        extensions: { field: "confirmName" },
      });
    }
    const record = await recordNewChain(
      tx,
      guest,
      { at: at.toISOString(), reason: "reset", target, actor: actor.label },
      at,
    );
    await tx
      .update(pveGuests)
      .set({
        repositorySecretId: null,
        repositoryReadyAt: null,
        repositoryBytes: null,
        repositoryMeasuredAt: null,
      })
      .where(eq(pveGuests.id, guest.id));
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.repositoryReset,
      target: guest.id,
      targetType: "pve_guest",
      details: {
        vmid: guest.vmid,
        name: guest.name,
        target: target.name,
        installationDefault: target.installationDefault,
        unavailablePoints: record.unavailablePoints,
      },
    });
    return { unavailablePoints: record.unavailablePoints };
  });
  return result;
}
