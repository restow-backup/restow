import { randomBytes } from "node:crypto";
import {
  freshRepositoryPrefix,
  INSTALLATION_DEFAULT_TARGET_ID,
  isWriteRefused,
  repositoryPrefixOf,
  resticBinary,
  resticCacheBase,
  resticInit,
  type StorageBackend,
  sealEndpointPassword,
  withRepository,
  writeRefusalCode,
} from "@restow/core";
import {
  type Database,
  PVE_REPOSITORY_CHAINS_KEPT,
  PVE_REPOSITORY_REPAIR_FAILED,
  type PveGuest,
  type PveRepositoryChain,
  type PveRepositoryProblem,
  pveGuests,
  pveSnapshots,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../../db.js";
import { loadTenantDek, readSecret, storeSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { type DestinationDeps, destinationRecord } from "../storage/destination.js";
import { auditPve, PVE_AUDIT_ACTIONS, type PveActor } from "./audit.js";
import {
  type SearchedTarget,
  searchedTargets,
  storeTarget,
  storeTargetWriteOnce,
  type TenantChunkStore,
  tenantChunkStore,
} from "./store.js";

/**
 * The restic repository of a container (docs/PVE.md, "Container repositories"): one per guest
 * under `pve-guests/<guest id>/` of the tenant's primary target. The server creates it (a node
 * is append-only and cannot) and hands every backup run a credential for it.
 *
 * Before a backup run gets its credential, the server makes sure the repository is really
 * there, on the target the run was pinned to (the primary when the credential was issued,
 * docs/STORAGE.md "Runs and storage changes"): `repository_ready_at` only says it was created
 * once, not that it still exists. When it is not complete on the primary, every target of the
 * tenant and the installation default are searched (docs/PVE.md, "Repository problems"), and
 * the backup is refused with a problem the guest page explains:
 *
 *   - `pve-repository-elsewhere`: complete on another target (a move or a repair brings it over);
 *   - `pve-repository-split`: data without `config` on the primary, or parts on another target
 *     (a run that straddled a storage change; the repair rebuilds it where it can);
 *   - `pve-repository-missing`: on no target, while restore points still refer to it (the way
 *     out is "Reset repository", which makes them unavailable);
 *   - `pve-repository-repair-failed`: the repository repair could not rebuild it. Refused even
 *     when `config` and a key are on the primary: they may sit next to data that is not whole.
 *     A repair that succeeds, or a reset, clears it.
 *
 * Only when the repository is on no target and no restore point refers to it does a new chain
 * begin without asking (nothing is lost by it). Never before 0.5.0 did the server ask: a
 * repository it could not find started a new chain and made every restore point unavailable.
 */

export const PVE_REPOSITORY_PROBLEMS = {
  elsewhere: "urn:restow:problem:pve-repository-elsewhere",
  split: "urn:restow:problem:pve-repository-split",
  missing: "urn:restow:problem:pve-repository-missing",
  unreachable: "urn:restow:problem:pve-repository-unreachable",
  notContainer: "urn:restow:problem:pve-repository-not-container",
  confirmName: "urn:restow:problem:pve-repository-confirm-name",
  leftover: "urn:restow:problem:pve-repository-leftover",
  initFailed: "urn:restow:problem:pve-repository-init-failed",
  repairFailed: `urn:restow:problem:${PVE_REPOSITORY_REPAIR_FAILED}`,
} as const;

/** The problem a run gets when its storage target stopped being the primary. */
export const STORAGE_SWITCHED_PROBLEM = "urn:restow:problem:storage-switched-during-run";

/**
 * The run's storage target stopped being the primary. 409 where a node asks for a credential;
 * 403 for a restic request, which restic takes as final (it retries a 409 for minutes).
 */
export function storageSwitchedDuringRun(status: 403 | 409 = 409): ProblemError {
  return new ProblemError(status, "Storage changed during the run", {
    type: STORAGE_SWITCHED_PROBLEM,
    detail:
      "The primary storage target of this tenant changed while this run was going. The run stops here instead of writing the rest of its backup to another target; the next run uses the new primary.",
  });
}

/** The problem a backup gets while a repository repair of the tenant is queued or running. */
export const REPOSITORY_REPAIR_RUNNING_PROBLEM = "urn:restow:problem:storage-repair-running";

export function repositoryRepairRunning(): ProblemError {
  return new ProblemError(409, "Repository repair running", {
    type: REPOSITORY_REPAIR_RUNNING_PROBLEM,
    detail:
      "A repository repair of this tenant is queued or running (Repositories › Repository repair). Backups wait for it: it may be rebuilding or moving aside the repository this backup would write to. The next scheduled backup runs as usual.",
  });
}

/**
 * The prefix a container's repository lies under on its storage target: `pve-guests/<id>/`, or
 * the fresh prefix its current chain began under when the old one could not be cleared (a
 * write-once target, docs/STORAGE.md "Write-once storage"; `pve_guests.repository_prefix`).
 * Every reader opens this one.
 */
export function guestRepositoryPrefix(guest: Pick<PveGuest, "id" | "repositoryPrefix">): string {
  return repositoryPrefixOf("container", guest.id, guest.repositoryPrefix);
}

/** {@link guestRepositoryPrefix} of a guest known by its id (its row is read). */
export async function guestRepositoryPrefixOf(
  database: Database,
  tenantId: string,
  guestId: string,
): Promise<string> {
  const [row] = await withTenantTx(database, tenantId, (tx) =>
    tx
      .select({ id: pveGuests.id, repositoryPrefix: pveGuests.repositoryPrefix })
      .from(pveGuests)
      .where(eq(pveGuests.id, guestId))
      .limit(1),
  );
  return guestRepositoryPrefix(row ?? { id: guestId, repositoryPrefix: null });
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
  /** Wraps the run's target (tests: a storage that refuses deletes). */
  backend?: (backend: StorageBackend) => StorageBackend;
}

function unreachable(error: unknown): ProblemError {
  return new ProblemError(503, "Storage not reachable", {
    type: PVE_REPOSITORY_PROBLEMS.unreachable,
    detail: `The storage target of this container's backups did not answer: ${
      error instanceof Error ? error.message : String(error)
    }`,
  });
}

/** The files of a repository on `backend`, lock files aside; a storage that does not answer is an error. */
async function repositoryFiles(backend: StorageBackend, prefix: string): Promise<string[]> {
  try {
    return (await backend.list(prefix)).filter((key) => !key.startsWith(`${prefix}locks/`));
  } catch (error) {
    throw unreachable(error);
  }
}

/** Whether `backend` holds the repository's `config` and at least one key. */
async function completeOn(backend: StorageBackend, prefix: string): Promise<boolean> {
  try {
    if ((await backend.head(`${prefix}config`)) === null) {
      return false;
    }
    return (await backend.list(`${prefix}keys/`)).length > 0;
  } catch (error) {
    throw unreachable(error);
  }
}

/** What one place holds of a repository. */
export interface RepositoryHolding {
  readonly target: SearchedTarget;
  readonly config: boolean;
  readonly keys: number;
  /** Files other than `config`, keys and the sealed password file. */
  readonly data: number;
}

function holdingOf(
  target: SearchedTarget,
  prefix: string,
  files: readonly string[],
): RepositoryHolding {
  let keys = 0;
  let data = 0;
  let config = false;
  for (const key of files) {
    const rest = key.slice(prefix.length);
    if (rest === "config") {
      config = true;
    } else if (rest.startsWith("keys/")) {
      keys += 1;
    } else if (rest !== REPOSITORY_PASSWORD_FILE) {
      data += 1;
    }
  }
  return { target, config, keys, data };
}

/** The sealed password file next to every repository. */
const REPOSITORY_PASSWORD_FILE = "restow-repository-password.json";

/**
 * Where the parts of a repository lie, the primary first: every target of the tenant and the
 * installation default (`searchedTargets`). A target that does not answer is skipped, except
 * the primary.
 */
export async function locateRepository(
  store: TenantChunkStore,
  primary: { id: string; backend: StorageBackend },
  prefix: string,
): Promise<RepositoryHolding[]> {
  const holdings: RepositoryHolding[] = [];
  const primaryTarget: SearchedTarget = {
    id: primary.id,
    name: store.targets.find((target) => target.id === primary.id)?.name ?? null,
    role: "primary",
    backend: primary.backend,
  };
  holdings.push(holdingOf(primaryTarget, prefix, await repositoryFiles(primary.backend, prefix)));
  for (const target of await searchedTargets(store)) {
    if (target.id === primary.id || target.backend === primary.backend) {
      continue;
    }
    const files = await target.backend.list(prefix).catch(() => null);
    if (files === null) {
      continue;
    }
    const listed = files.filter((key) => !key.startsWith(`${prefix}locks/`));
    if (listed.length > 0) {
      holdings.push(holdingOf(target, prefix, listed));
    }
  }
  return holdings;
}

function targetLabel(target: SearchedTarget): string {
  if (target.id === INSTALLATION_DEFAULT_TARGET_ID) {
    return "the installation default";
  }
  return target.name ? `"${target.name}"` : "a retired target";
}

async function activePointCount(
  database: Database,
  tenantId: string,
  guestId: string,
): Promise<number> {
  const rows = await withTenantTx(database, tenantId, (tx) =>
    tx
      .select({ id: pveSnapshots.id })
      .from(pveSnapshots)
      .where(
        and(
          eq(pveSnapshots.guestId, guestId),
          eq(pveSnapshots.kind, "ct"),
          eq(pveSnapshots.status, "active"),
        ),
      ),
  );
  return rows.length;
}

/** Record (or clear) why the last backup of the container was refused; the guest page shows it. */
export async function recordRepositoryProblem(
  database: Database,
  tenantId: string,
  guestId: string,
  problem: PveRepositoryProblem | null,
): Promise<void> {
  await withTenantTx(database, tenantId, (tx) =>
    tx.update(pveGuests).set({ repositoryProblem: problem }).where(eq(pveGuests.id, guestId)),
  );
}

/** The repository problem as a 409, recorded on the guest first. */
async function refuse(
  database: Database,
  tenantId: string,
  guest: PveGuest,
  kind: "elsewhere" | "split" | "missing",
  heldBy: SearchedTarget | null,
  activePoints: number,
  now: Date,
): Promise<never> {
  await recordRepositoryProblem(database, tenantId, guest.id, {
    at: now.toISOString(),
    type: PVE_REPOSITORY_PROBLEMS[kind].slice("urn:restow:problem:".length),
    heldBy: heldBy
      ? heldBy.id === INSTALLATION_DEFAULT_TARGET_ID
        ? "installation_default"
        : (heldBy.name ?? heldBy.id)
      : null,
    activePoints,
  });
  const where = heldBy ? targetLabel(heldBy) : null;
  if (kind === "elsewhere") {
    throw new ProblemError(409, "Repository on another storage target", {
      type: PVE_REPOSITORY_PROBLEMS.elsewhere,
      detail: `The repository of this container is not on the current primary storage target but on ${where}. Bring it to the primary (Repositories › Repository repair, or replace the primary with "move"), or reset the repository on the guest page to begin a new backup chain.`,
      extensions: { heldBy: where, activePoints },
    });
  }
  if (kind === "split") {
    throw new ProblemError(409, "Repository split across storage targets", {
      type: PVE_REPOSITORY_PROBLEMS.split,
      detail: `The repository of this container is incomplete: ${
        where
          ? `parts of it lie on ${where}`
          : "the primary holds its data but not its config or keys"
      }. A backup that ran while the primary storage target changed wrote to two targets. Run the repository repair (Repositories › Repository repair), which rebuilds it on the primary where the parts allow; or reset the repository on the guest page to begin a new backup chain.`,
      extensions: { heldBy: where, activePoints },
    });
  }
  throw new ProblemError(409, "Repository missing", {
    type: PVE_REPOSITORY_PROBLEMS.missing,
    detail: `The repository of this container is on no storage target of this tenant, but ${activePoints} restore point(s) still refer to it. If an old storage location still has it, attach it read-only and run the repository repair (Repositories › Repository repair). Otherwise reset the repository on the guest page: its restore points become unavailable and the next backup begins a new chain.`,
    extensions: { activePoints },
  });
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
  reason: "chain" | "lost" = "chain",
): Promise<PveRepositoryChain> {
  const marked = await tx
    .update(pveSnapshots)
    .set({ status: "unavailable", unavailableAt: now, unavailableReason: reason })
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
      repositoryProblem: null,
    })
    .where(eq(pveGuests.id, guest.id));
  return record;
}

/**
 * Move every object under `prefix` aside to `<prefix without slash>.orphaned-<time>/` on the
 * same target: never deleted, an operator can still look at it (or delete it).
 */
export async function moveRepositoryAside(
  backend: StorageBackend,
  prefix: string,
  now: Date,
): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const destination = `${prefix.replace(/\/$/, "")}.orphaned-${stamp}/`;
  for (const key of await backend.list(prefix)) {
    const target = `${destination}${key.slice(prefix.length)}`;
    await backend.put(target, await backend.getStream(key));
    await backend.delete(key);
  }
  return destination;
}

/** Whether `files` are only what a `restic init` writes (and the password file next to it). */
function onlyEmptyRepository(prefix: string, files: readonly string[]): boolean {
  return files.every(
    (key) =>
      key === `${prefix}config` ||
      key.startsWith(`${prefix}keys/`) ||
      key === `${prefix}${REPOSITORY_PASSWORD_FILE}`,
  );
}

/**
 * Create the repository on `primary` (the target the run was pinned to) with a new password.
 *
 *   - What an earlier chain left at the prefix (after a reset, or after the repair found the
 *     repository lost) is moved aside to `<prefix>.orphaned-<time>/` first, never deleted: no
 *     active restore point refers to it, but it may be half of a split repository that is still
 *     wanted. Only an empty repository (config, keys and password file, no data: a creation that
 *     never got recorded) is removed.
 *   - On a write-once target (`writeOnce`, its last probe), or when the storage refuses to delete
 *     or move what lies there (EPERM and the like), nothing is touched: the new chain begins
 *     under a fresh prefix next to it (`pve-guests/<id>.chain-<n>/`), recorded on the guest, and
 *     the old chain stays where it was (docs/STORAGE.md, "Write-once storage").
 *   - Data without `config` (a split repository) is refused with `pve-repository-split`:
 *     `restic init` would fail on it ("repository already contains snapshots", the HTTP 500 of
 *     0.4.x), unless it is right after a reset (no active restore point): moved aside as above.
 *   - The password is stored only once `restic init` succeeded, so a failed attempt leaves
 *     no orphan secret behind.
 */
async function createRepository(
  database: Database,
  tenantId: string,
  guest: PveGuest,
  primary: StorageBackend,
  now: Date,
  writeOnce = false,
): Promise<string> {
  const previousPrefix = guestRepositoryPrefix(guest);
  let prefix = previousPrefix;
  let fresh: { prefix: string; why: string } | null = null;
  const files = await repositoryFiles(primary, prefix);
  if (files.length > 0) {
    const active = await activePointCount(database, tenantId, guest.id);
    const afterReset =
      guest.repositoryReadyAt === null &&
      (guest.repositoryChains?.[0]?.reason === "reset" ||
        guest.repositoryChains?.[0]?.reason === "lost");
    const hasConfig = files.includes(`${prefix}config`);
    if (active > 0 && hasConfig) {
      throw new ProblemError(409, "Repository state unclear", {
        type: PVE_REPOSITORY_PROBLEMS.leftover,
        detail:
          "The container has restore points, but its repository is not recorded as ready. Reset the repository on the guest page to begin a new backup chain.",
      });
    }
    const clear =
      hasConfig && onlyEmptyRepository(prefix, files)
        ? "delete"
        : hasConfig || (afterReset && active === 0)
          ? "move"
          : null;
    if (clear === null) {
      await refuse(database, tenantId, guest, "split", null, active, now);
    }
    if (writeOnce) {
      fresh = { prefix: await nextPrefix(primary, guest, prefix), why: "write_once" };
    } else {
      try {
        if (clear === "delete") {
          for (const key of files) {
            await primary.delete(key);
          }
        } else {
          await moveRepositoryAside(primary, prefix, now);
        }
      } catch (error) {
        if (!isWriteRefused(error)) {
          throw unreachable(error);
        }
        // The storage refuses to delete or move (a write-once share the probe has not seen yet):
        // what lies there stays, the new chain goes next to it.
        fresh = {
          prefix: await nextPrefix(primary, guest, prefix),
          why: writeRefusalCode(error) ?? "refused",
        };
      }
    }
    if (fresh) {
      prefix = fresh.prefix;
    }
  }
  const password = randomBytes(32).toString("base64url");
  try {
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
  } catch (error) {
    throw new ProblemError(503, "Repository could not be created", {
      type: PVE_REPOSITORY_PROBLEMS.initFailed,
      detail: `restic could not create the repository of this container on the primary storage target: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  const secret = await storeSecret(database, {
    tenantId,
    kind: PVE_REPOSITORY_SECRET_KIND,
    plaintext: password,
  });
  const dek = await withTenantTx(database, tenantId, (tx) => loadTenantDek(tx, tenantId));
  // Next to the repository, sealed with the tenant key: storage and master key restore without this database.
  await primary.put(
    `${prefix}${REPOSITORY_PASSWORD_FILE}`,
    sealEndpointPassword({ tenantId, endpointId: guest.id, password, dek }),
  );
  await withTenantTx(database, tenantId, async (tx) => {
    await tx
      .update(pveGuests)
      .set({
        repositorySecretId: secret.id,
        repositoryReadyAt: new Date(),
        repositoryBytes: null,
        repositoryMeasuredAt: null,
        repositoryProblem: null,
        ...(fresh ? { repositoryPrefix: fresh.prefix } : {}),
      })
      .where(eq(pveGuests.id, guest.id));
    if (!fresh) {
      return;
    }
    // The chain this begins (the newest record, a reset or a repair's "lost") says where it lies.
    const [current] = await tx
      .select({ chains: pveGuests.repositoryChains })
      .from(pveGuests)
      .where(eq(pveGuests.id, guest.id));
    const [newest, ...older] = current?.chains ?? [];
    if (newest && newest.prefix === undefined) {
      await tx
        .update(pveGuests)
        .set({ repositoryChains: [{ ...newest, prefix: fresh.prefix, previousPrefix }, ...older] })
        .where(eq(pveGuests.id, guest.id));
    }
    await auditPve(tx, {
      tenantId,
      actor: { label: "system", userId: null, ip: null },
      action: PVE_AUDIT_ACTIONS.repositoryFreshPrefix,
      target: guest.id,
      targetType: "pve_guest",
      details: {
        vmid: guest.vmid,
        prefix: fresh.prefix,
        previousPrefix,
        reason: fresh.why,
      },
    });
  });
  return password;
}

/** The fresh prefix a new chain of `guest` begins under (lists the target, writes nothing). */
async function nextPrefix(
  primary: StorageBackend,
  guest: Pick<PveGuest, "id">,
  current: string,
): Promise<string> {
  try {
    return await freshRepositoryPrefix(primary, "container", guest.id, current);
  } catch (error) {
    throw unreachable(error);
  }
}

/**
 * The repository password of a container for a run, creating the repository when it does not
 * exist yet. `write` (a backup) also makes sure the repository is complete on the run's target
 * (`target`, the primary its credential was issued for): see the module comment for what
 * happens when it is not. Reads (a restore) never create anything: the restic route reads from
 * whichever target holds the repository.
 */
export async function ensureGuestRepository(
  tenantId: string,
  guestId: string,
  run: { runId: string; write: boolean; target?: string },
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
  const targetId = run.target ?? store.primaryTarget;
  const pinned = storeTarget(store, targetId);
  if (!pinned || (run.write && targetId !== store.primaryTarget)) {
    throw storageSwitchedDuringRun();
  }
  const primaryBackend = deps.backend ? deps.backend(pinned) : pinned;
  const prefix = guestRepositoryPrefix(guest);
  const writeOnce = storeTargetWriteOnce(store, targetId);
  if (run.write && guest.repositoryProblem?.type === PVE_REPOSITORY_REPAIR_FAILED) {
    throw new ProblemError(409, "Repository repair failed", {
      type: PVE_REPOSITORY_PROBLEMS.repairFailed,
      detail:
        "The repository repair could not rebuild the repository of this container on the primary storage target, so backups are refused: the next one would build on data that is not whole. See the result of the last repair under Repositories › Repository repair. Repair again once the missing parts are attached, or reset the repository on the guest page to begin a new backup chain.",
      extensions: { activePoints: guest.repositoryProblem.activePoints },
    });
  }
  if (guest.repositorySecretId && guest.repositoryReadyAt) {
    const password = await readSecret(database, { id: guest.repositorySecretId, tenantId });
    if (password) {
      if (!run.write || checkedRuns.has(run.runId)) {
        return password;
      }
      if (await completeOn(primaryBackend, prefix)) {
        if (guest.repositoryProblem) {
          await recordRepositoryProblem(database, tenantId, guest.id, null);
        }
        rememberChecked(run.runId);
        return password;
      }
      const holdings = await locateRepository(
        store,
        { id: targetId, backend: primaryBackend },
        prefix,
      );
      const [onPrimary, ...others] = holdings as [RepositoryHolding, ...RepositoryHolding[]];
      const othersWithData = others.filter(
        (other) => other.data > 0 || other.config || other.keys > 0,
      );
      const active = await activePointCount(database, tenantId, guest.id);
      const complete = othersWithData.find((other) => other.config && other.keys > 0);
      if (onPrimary.config || onPrimary.keys > 0 || onPrimary.data > 0) {
        await refuse(
          database,
          tenantId,
          guest,
          "split",
          complete?.target ?? othersWithData[0]?.target ?? null,
          active,
          now(),
        );
      }
      if (complete) {
        const split = othersWithData.some((other) => other !== complete);
        await refuse(
          database,
          tenantId,
          guest,
          split ? "split" : "elsewhere",
          complete.target,
          active,
          now(),
        );
      }
      if (othersWithData.length > 0) {
        await refuse(
          database,
          tenantId,
          guest,
          "split",
          othersWithData[0]?.target ?? null,
          active,
          now(),
        );
      }
      if (active > 0) {
        await refuse(database, tenantId, guest, "missing", null, active, now());
      }
      // Gone everywhere and nothing refers to it: a new chain begins (below), and the guest says so.
      const password2 = await createRepository(
        database,
        tenantId,
        guest,
        primaryBackend,
        now(),
        writeOnce,
      );
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
  const password = await createRepository(
    database,
    tenantId,
    guest,
    primaryBackend,
    now(),
    writeOnce,
  );
  rememberChecked(run.runId);
  return password;
}

/**
 * Reset a container's repository (an administrator, typed confirmation and a recent sign-in
 * checked by the route): its restore points become unavailable at once, and the next backup
 * begins a new chain in a new repository. Whatever of the old repository is on the primary is
 * moved aside by that backup before it creates the new one (`createRepository`: never deleted);
 * on a write-once target it stays where it is and the new chain begins under a fresh prefix. A
 * retired target is never touched.
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
