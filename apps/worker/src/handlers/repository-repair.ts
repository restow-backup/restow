/**
 * The repository repair of a tenant (docs/STORAGE.md, "Repository repair"): for installations
 * whose restic repositories were split across storage targets, or dropped with the installation
 * default by a promotion of 0.4.1.
 *
 * An administrator queues a scan (`storage_repository_repairs`, kind `scan`); this pass lists
 * every restic repository of the tenant on every place it may lie (the primary, the copies, the
 * retired targets, an old location attached read-only, the installation default) and classifies
 * it (storage-migration-restic.ts `planRepositories`). Nothing is changed. A place that could not
 * be read (an error, or the empty or missing folder of a share that is not mounted) is named in
 * the result; a repair refuses to apply such a scan.
 *
 * "Apply" (kind `apply`, queued with a recent sign-in and a typed confirmation, naming the scan
 * it was decided on) refuses while a backup, a file share run or a storage migration of the
 * tenant is active (credential issue and every change of the primary refuse while it is queued
 * or running, @restow/db `repositoryRepairActive`). It plans again from a fresh listing in which
 * every place must answer, and acts only on a repository whose findings are the same as in the
 * confirmed scan (anything else is left and reported as changed). Per repository, under its
 * repository lock (the one retention and the check take):
 *
 *   - `elsewhere`, `split`: copies every data, index and snapshot file the primary lacks onto
 *     it, each verified against its SHA-256; only then the keys, and `config` last. Then
 *     `restic check` (structure) and `restic snapshots` there. When a file cannot be copied, or
 *     restic finds the result not sound, the keys and `config` it copied are moved aside again
 *     and a container records `pve-repository-repair-failed`, on which backups, retention and the
 *     check refuse. A container's restore points (created before the repair began) whose restic
 *     snapshot is not in the rebuilt repository become unavailable (`points_lost`; the chain
 *     goes on);
 *   - a container's repository with data but no `config` or no key anywhere (`data_only`), or
 *     only its password file: its restore points become unavailable ("lost"), what lies at its
 *     prefix on the primary is moved aside (never deleted), and the next backup begins a new
 *     chain;
 *   - everything else (on no target at all, two chains under one prefix, a machine's or a file
 *     share's incomplete repository) is listed and left as it is: an operator decides. A
 *     repository on no target is never marked lost here: an absent share looks the same, and
 *     "Reset repository" on the guest page is the deliberate way.
 *
 * The repair does not bring back the restore points of a chain that 0.4.2 to 0.4.12 replaced
 * silently (`pve.repository.reinitialized`): the primary holds the new chain, which is complete,
 * so the old one is no part of it.
 *
 * Audited as `storage.repositories.scanned`, `storage.repository.merged` and
 * `storage.repository.lost`. One pass at a time across the installation (an advisory lock);
 * one scan or repair at a time per tenant (a unique index).
 */
import {
  deletionDecision,
  INSTALLATION_DEFAULT_TARGET_ID,
  isWriteRefused,
  type MirrorItem,
  type MirrorItemResult,
  mirrorItem,
  type RepositoryAccess,
  readOnlyFallbackChain,
  resticBinary,
  resticCacheBase,
  resticCheckStructure,
  resticErrorDetail,
  resticSnapshots,
  type StorageBackend,
  withDeletionPermit,
  withRepository,
} from "@restow/core";
import {
  type Database,
  EndpointRepositoryBusyError,
  endpointRuns,
  fileShareRuns,
  lockTenantStorage,
  PVE_REPOSITORY_CHAINS_KEPT,
  PVE_REPOSITORY_REPAIR_FAILED,
  pveGuestRepositoryLockKey,
  pveGuests,
  pveRuns,
  pveSnapshots,
  type StorageRepositoryRepair,
  type StorageRepositoryRepairEntry,
  type StorageRepositoryRepairResult,
  type StorageRepositoryScanEntry,
  storageGeneration,
  storageRepositoryRepairs,
  withEndpointRepositoryLock,
} from "@restow/db";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import { processDefaultStorage } from "../default-storage.js";
import { shareLockKey } from "../file-shares/common.js";
import {
  freshTenantStorage,
  PgSecretReader,
  tenantRunner,
  type WorkerRuntime,
  withTenantTx,
} from "./framework.js";
import { hasActiveMigration } from "./storage-migration.js";
import {
  activePointsOf,
  planRepositoriesOf,
  REPOSITORY_PASSWORD_FILE,
  type RepositoryOwner,
  type RepositoryPlan,
  type RepositorySource,
  tenantRepositoryOwners,
  type UnreachableSource,
} from "./storage-migration-restic.js";

export const REPAIR_AUDIT_ACTIONS = {
  scanned: "storage.repositories.scanned",
  merged: "storage.repository.merged",
  lost: "storage.repository.lost",
} as const;

const PASS_INTERVAL_MS = 15_000;
const LOCK_KEY = 0x52455052; // "REPR"
/** How long the repair waits for retention, a check or a read of one repository. */
const REPOSITORY_LOCK_WAIT_MS = 60_000;

/** restic as the repair uses it (tests replace it). */
export interface RepairRestic {
  /** `restic check` without reading pack data; throws when the repository is not sound. */
  check(access: RepositoryAccess): Promise<void>;
  /** The ids of the repository's snapshots. */
  snapshots(access: RepositoryAccess): Promise<string[]>;
}

export const realRepairRestic: RepairRestic = {
  async check(access) {
    await withRepository(access, (session) => resticCheckStructure(session));
  },
  async snapshots(access) {
    return withRepository(access, async (session) =>
      (await resticSnapshots(session, { noLock: true })).map((snapshot) => snapshot.id),
    );
  },
};

export interface RepairDeps {
  /** The application role (Row Level Security). */
  readonly db: Database;
  /** The installation role: the queue of every tenant. */
  readonly providerDb: Database;
  readonly runtime: Pick<WorkerRuntime, "keyrings" | "storage" | "logger" | "now">;
  readonly restic?: RepairRestic;
  /** The installation default (tests pin it); the current one without it. */
  readonly installationDefault?: () => Promise<StorageBackend | null>;
  /** How long to wait for a repository's lock (tests shorten it). */
  readonly repositoryLockWaitMs?: number;
  /** Called before each repository is worked on (tests interleave other work there). */
  readonly beforeRepository?: (owner: RepositoryOwner) => Promise<void>;
}

/** Every place a repository of the tenant may lie, the primary first, and why the default could not be opened. */
async function sourcesOf(
  deps: RepairDeps,
  tenantId: string,
): Promise<{ sources: RepositorySource[]; defaultUnreadable: string | null }> {
  const storage = await freshTenantStorage(
    tenantRunner(deps.db, tenantId),
    deps.runtime.storage,
    tenantId,
  );
  const sources: RepositorySource[] = [];
  const targets = storage.targets ?? [
    { id: "primary", name: null, role: "primary" as const, backend: storage.primary },
  ];
  for (const target of targets) {
    if (sources.some((known) => known.backend === target.backend || known.id === target.id)) {
      continue;
    }
    sources.push({
      id: target.id,
      name:
        target.name ??
        (target.id === INSTALLATION_DEFAULT_TARGET_ID ? "Installation default" : target.id),
      role: target.role,
      backend: target.backend,
      writeOnce: target.writeOnce === true,
    });
  }
  let defaultUnreadable: string | null = null;
  if (!sources.some((known) => known.id === INSTALLATION_DEFAULT_TARGET_ID)) {
    let fallback: StorageBackend | null = null;
    try {
      fallback = deps.installationDefault
        ? await deps.installationDefault()
        : (await processDefaultStorage().current()).targets.primary;
    } catch (error) {
      // Not silently left out: a repository that only it holds would look lost.
      defaultUnreadable = error instanceof Error ? error.message : String(error);
    }
    if (fallback && !sources.some((known) => known.backend === fallback)) {
      sources.push({
        id: INSTALLATION_DEFAULT_TARGET_ID,
        name: "Installation default",
        role: "installation_default",
        optional: true,
        backend: fallback,
      });
    }
  }
  return { sources, defaultUnreadable };
}

function repairable(plan: RepositoryPlan): boolean {
  return plan.class === "elsewhere" || plan.class === "split";
}

async function scanEntries(
  deps: RepairDeps,
  tenantId: string,
  plans: readonly RepositoryPlan[],
): Promise<StorageRepositoryScanEntry[]> {
  const run = tenantRunner(deps.db, tenantId);
  const entries: StorageRepositoryScanEntry[] = [];
  for (const plan of plans) {
    entries.push({
      prefix: plan.owner.prefix,
      kind: plan.owner.kind,
      ownerId: plan.owner.ownerId,
      name: plan.owner.name,
      class: plan.class,
      holdings: plan.holdings,
      filesToCopy: plan.missingOnReference,
      activePoints: await activePointsOf(run, plan.owner),
      repairable: repairable(plan),
    });
  }
  return entries;
}

async function audit(
  deps: RepairDeps,
  tenantId: string,
  actor: string,
  action: string,
  target: string,
  targetType: string,
  details: Record<string, unknown>,
): Promise<void> {
  await withTenantTx(deps.db, tenantId, (tx) =>
    appendAuditEntry(tx, { tenantId, actor, action, target, targetType, details }),
  );
}

/** List and classify; nothing is changed. */
export async function scanRepositories(
  deps: RepairDeps,
  row: Pick<StorageRepositoryRepair, "id" | "tenantId" | "requestedBy">,
): Promise<StorageRepositoryRepairResult> {
  const { sources, defaultUnreadable } = await sourcesOf(deps, row.tenantId);
  const owners = await tenantRepositoryOwners(tenantRunner(deps.db, row.tenantId), row.tenantId);
  const planned = await planRepositoriesOf(owners, sources, sources[0] ?? null, {
    unreachable: "record",
  });
  const unreachable: UnreachableSource[] = [
    ...planned.unreachable,
    ...(defaultUnreadable
      ? [
          {
            id: INSTALLATION_DEFAULT_TARGET_ID,
            name: "Installation default",
            reason: defaultUnreadable,
          },
        ]
      : []),
  ];
  const entries = await scanEntries(deps, row.tenantId, planned.plans);
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.class] = (counts[entry.class] ?? 0) + 1;
  }
  await audit(
    deps,
    row.tenantId,
    row.requestedBy,
    REPAIR_AUDIT_ACTIONS.scanned,
    row.id,
    "storage_repository_repair",
    {
      repositories: entries.length,
      classes: counts,
      targets: sources.map((source) => source.name),
      ...(unreachable.length > 0 ? { unreachable: unreachable.map((u) => u.name) } : {}),
    },
  );
  return {
    repositories: entries,
    sources: sources.map((source) => source.id),
    unreachable,
  };
}

async function guestPassword(
  deps: RepairDeps,
  tenantId: string,
  secretId: string | null,
): Promise<string | null> {
  if (!secretId) {
    return null;
  }
  const keys = await deps.runtime.keyrings.get(tenantId);
  return new PgSecretReader(tenantRunner(deps.db, tenantId), tenantId, keys)
    .get(secretId)
    .catch(() => null);
}

function asideOf(prefix: string, now: Date): string {
  return `${prefix.replace(/\/$/, "")}.orphaned-${now.toISOString().replace(/[:.]/g, "-")}/`;
}

/**
 * Move `keys` (every object under `prefix` when null) aside to `<prefix>.orphaned-<time>/`
 * (never deleted). Returns where they went, or null when there was nothing to move.
 */
async function moveAside(
  backend: StorageBackend,
  prefix: string,
  now: Date,
  keys: readonly string[] | null = null,
): Promise<string | null> {
  const moving = keys ?? (await backend.list(prefix));
  if (moving.length === 0) {
    return null;
  }
  const destination = asideOf(prefix, now);
  for (const key of moving) {
    await backend.put(`${destination}${key.slice(prefix.length)}`, await backend.getStream(key));
    await backend.delete(key);
  }
  return destination;
}

/**
 * A container's restore points: these become unavailable as lost (and its guest records it).
 * `resetRepository`: the repository is gone, the next backup begins a new chain ("lost");
 * otherwise the repository was rebuilt and its chain goes on ("points_lost").
 */
async function markContainerPointsLost(
  deps: RepairDeps,
  tenantId: string,
  guestId: string,
  pointIds: readonly string[] | "all",
  actor: string,
  resetRepository: boolean,
): Promise<number> {
  const now = deps.runtime.now();
  return withTenantTx(deps.db, tenantId, async (tx) => {
    const [guest] = await tx
      .select()
      .from(pveGuests)
      .where(eq(pveGuests.id, guestId))
      .for("update")
      .limit(1);
    if (!guest) {
      return 0;
    }
    const active = and(
      eq(pveSnapshots.guestId, guestId),
      eq(pveSnapshots.kind, "ct"),
      eq(pveSnapshots.status, "active"),
    );
    const marked =
      pointIds === "all"
        ? await tx
            .update(pveSnapshots)
            .set({ status: "unavailable", unavailableAt: now, unavailableReason: "lost" })
            .where(active)
            .returning({ id: pveSnapshots.id })
        : pointIds.length === 0
          ? []
          : await tx
              .update(pveSnapshots)
              .set({ status: "unavailable", unavailableAt: now, unavailableReason: "lost" })
              .where(and(active, inArray(pveSnapshots.id, [...pointIds])))
              .returning({ id: pveSnapshots.id });
    const lost = marked.length;
    if (lost > 0 || resetRepository) {
      await tx
        .update(pveGuests)
        .set({
          repositoryChains: [
            {
              at: now.toISOString(),
              reason: resetRepository ? ("lost" as const) : ("points_lost" as const),
              target: null,
              unavailablePoints: lost,
              actor,
            },
            ...(guest.repositoryChains ?? []),
          ].slice(0, PVE_REPOSITORY_CHAINS_KEPT),
          repositoryProblem: null,
          ...(resetRepository
            ? {
                repositorySecretId: null,
                repositoryReadyAt: null,
                repositoryBytes: null,
                repositoryMeasuredAt: null,
                lastSnapshotId: null,
                lastSuccessAt: null,
                lastVerifyAt: null,
                lastRestoreTestAt: null,
              }
            : {}),
        })
        .where(eq(pveGuests.id, guestId));
    }
    return lost;
  });
}

/**
 * The repair could not rebuild a container's repository: backups, retention and the check
 * refuse on it (`PVE_REPOSITORY_REPAIR_FAILED`) until a repair succeeds or it is reset.
 */
async function recordRepairFailed(
  deps: RepairDeps,
  tenantId: string,
  owner: RepositoryOwner,
): Promise<void> {
  if (owner.kind !== "container") {
    return;
  }
  const activePoints = await activePointsOf(tenantRunner(deps.db, tenantId), owner);
  await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .update(pveGuests)
      .set({
        repositoryProblem: {
          at: deps.runtime.now().toISOString(),
          type: PVE_REPOSITORY_REPAIR_FAILED,
          heldBy: null,
          activePoints,
        },
      })
      .where(eq(pveGuests.id, owner.ownerId)),
  );
}

/** What opens a repository: its keys, its config, the sealed password file next to it. */
function isHead(prefix: string, key: string): boolean {
  return (
    key === `${prefix}config` ||
    key.startsWith(`${prefix}keys/`) ||
    key === `${prefix}${REPOSITORY_PASSWORD_FILE}`
  );
}

/** Keys first, the password file, `config` last: the repository only opens once all are there. */
function headOrder(prefix: string, key: string): number {
  return key === `${prefix}config` ? 2 : key.startsWith(`${prefix}keys/`) ? 0 : 1;
}

/** Rebuild one complete-together repository on the primary (see the module comment). */
async function mergeOne(
  deps: RepairDeps,
  row: Pick<StorageRepositoryRepair, "id" | "tenantId" | "requestedBy">,
  plan: RepositoryPlan,
  sources: readonly RepositorySource[],
  restic: RepairRestic,
  started: Date,
): Promise<StorageRepositoryRepairEntry> {
  const primary = sources[0] as RepositorySource;
  const prefix = plan.owner.prefix;
  const base = {
    prefix,
    kind: plan.owner.kind,
    ownerId: plan.owner.ownerId,
    name: plan.owner.name,
  };
  // Read in the order the plan chose its config from: the primary first, then the others.
  const ordered = plan.configSource
    ? [plan.configSource, ...sources.filter((source) => source !== plan.configSource)]
    : [...sources];
  const reader = readOnlyFallbackChain(
    [primary, ...ordered.filter((source) => source !== primary)].map((source) => source.backend),
  );
  const body = plan.items.filter((item) => !isHead(prefix, item.key));
  const head = plan.items
    .filter((item) => isHead(prefix, item.key))
    .sort((a, b) => headOrder(prefix, a.key) - headOrder(prefix, b.key));
  let copied = 0;
  /** The keys and config this repair put on the primary: what is moved aside again on failure. */
  const written: string[] = [];
  const copy = async (items: readonly MirrorItem[], record: boolean) => {
    const problems: MirrorItemResult[] = [];
    for (const item of items) {
      const outcome = await mirrorItem(
        { source: reader, target: primary.backend, items: [], verify: "hash" },
        item,
      );
      if (outcome.outcome === "copied" || outcome.outcome === "repaired") {
        copied += 1;
        if (record) {
          written.push(item.key);
        }
      } else if (outcome.outcome !== "present") {
        problems.push(outcome);
        // Nothing after a failed file: the head must never land next to data that is not whole.
        break;
      }
    }
    return problems;
  };
  const fail = async (detail: string): Promise<StorageRepositoryRepairEntry> => {
    const movedTo = await moveAside(primary.backend, prefix, deps.runtime.now(), written).catch(
      () => null,
    );
    await recordRepairFailed(deps, row.tenantId, plan.owner);
    return { ...base, outcome: "failed", copied, lostPoints: 0, movedTo, detail };
  };
  const problems = [...(await copy(body, false))];
  if (problems.length === 0) {
    problems.push(...(await copy(head, true)));
  }
  if (problems.length > 0) {
    return fail(
      `${problems.length} file(s) could not be copied and verified: ${problems
        .slice(0, 5)
        .map((problem) => `${problem.key} (${problem.outcome})`)
        .join(", ")}`,
    );
  }
  const password = await guestPassword(deps, row.tenantId, plan.owner.secretId);
  let lostPoints = 0;
  if (password) {
    const access: RepositoryAccess = {
      storage: primary.backend,
      prefix,
      repositoryPassword: password,
      repositoryKey: `repair-${row.id}-${plan.owner.ownerId}`,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    };
    // The points are read before restic lists the snapshots, and only those that existed when
    // the repair began count: a point is never marked lost for a snapshot newer than the listing.
    const points =
      plan.owner.kind === "container"
        ? await withTenantTx(deps.db, row.tenantId, (tx) =>
            tx
              .select({ id: pveSnapshots.id, resticSnapshotId: pveSnapshots.resticSnapshotId })
              .from(pveSnapshots)
              .where(
                and(
                  eq(pveSnapshots.guestId, plan.owner.ownerId),
                  eq(pveSnapshots.kind, "ct"),
                  eq(pveSnapshots.status, "active"),
                  lte(pveSnapshots.createdAt, started),
                ),
              ),
          )
        : [];
    let snapshots: string[];
    try {
      await restic.check(access);
      snapshots = await restic.snapshots(access);
    } catch (error) {
      return fail(
        `restic found the rebuilt repository not sound: ${resticErrorDetail(error, 400)}`,
      );
    }
    if (plan.owner.kind === "container") {
      const known = new Set(snapshots);
      const lost = points
        .filter((point) => !point.resticSnapshotId || !known.has(point.resticSnapshotId))
        .map((point) => point.id);
      lostPoints = await markContainerPointsLost(
        deps,
        row.tenantId,
        plan.owner.ownerId,
        lost,
        row.requestedBy,
        false,
      );
      await withTenantTx(deps.db, row.tenantId, (tx) =>
        tx
          .update(pveGuests)
          .set({ repositoryProblem: null, repositoryBytes: null, repositoryMeasuredAt: null })
          .where(eq(pveGuests.id, plan.owner.ownerId)),
      );
    }
  }
  await audit(
    deps,
    row.tenantId,
    row.requestedBy,
    REPAIR_AUDIT_ACTIONS.merged,
    plan.owner.ownerId,
    plan.owner.kind === "container"
      ? "pve_guest"
      : plan.owner.kind === "machine"
        ? "endpoint"
        : "file_share",
    {
      repairId: row.id,
      prefix,
      class: plan.class,
      copied,
      lostPoints,
      checked: password !== null,
    },
  );
  return { ...base, outcome: "merged", copied, lostPoints, movedTo: null, detail: null };
}

/**
 * Why the repair must not start now, or null: a backup or file share run of the tenant is
 * running, or a storage migration is active. Read under the tenant's storage lock (which
 * credential issue and every change of the primary take, and which refuse while the repair is
 * queued or running); returns the storage generation the repair works on.
 */
async function quietTenant(
  deps: RepairDeps,
  tenantId: string,
): Promise<{ blocker: string | null; generation: string }> {
  const result = await withTenantTx(deps.db, tenantId, async (tx) => {
    await lockTenantStorage(tx, tenantId);
    const [backup] = await tx
      .select({ id: pveRuns.id })
      .from(pveRuns)
      .where(
        and(
          eq(pveRuns.tenantId, tenantId),
          eq(pveRuns.kind, "backup"),
          eq(pveRuns.status, "running"),
        ),
      )
      .limit(1);
    const [share] = await tx
      .select({ id: fileShareRuns.id })
      .from(fileShareRuns)
      .where(
        and(
          eq(fileShareRuns.tenantId, tenantId),
          inArray(fileShareRuns.status, ["starting", "running"]),
        ),
      )
      .limit(1);
    return {
      blocker: backup
        ? "a Proxmox VE backup of this tenant is running"
        : share
          ? "a file share run of this tenant is running"
          : null,
      generation: await storageGeneration(tx, tenantId),
    };
  });
  if (!result.blocker && (await hasActiveMigration(tenantRunner(deps.db, tenantId), tenantId))) {
    return { ...result, blocker: "a storage migration of this tenant is active" };
  }
  return result;
}

/** The lock retention, the check and the server's reads of `owner`'s repository take. */
function repositoryLockKey(owner: RepositoryOwner): string {
  return owner.kind === "container"
    ? pveGuestRepositoryLockKey(owner.ownerId)
    : owner.kind === "file_share"
      ? shareLockKey(owner.ownerId)
      : owner.ownerId;
}

/** Whether an agent's backup of the machine is running (it writes to the repository). */
async function machineRunning(
  deps: RepairDeps,
  tenantId: string,
  owner: RepositoryOwner,
): Promise<boolean> {
  if (owner.kind !== "machine") {
    return false;
  }
  const [row] = await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .select({ id: endpointRuns.id })
      .from(endpointRuns)
      .where(and(eq(endpointRuns.endpointId, owner.ownerId), eq(endpointRuns.status, "running")))
      .limit(1),
  );
  return row !== undefined;
}

/** A holding as compared with the confirmed scan: where it lies and whether it opens there. */
function holdingsKey(holdings: StorageRepositoryScanEntry["holdings"]): string {
  return holdings
    .map((holding) => `${holding.target}:${holding.config ? 1 : 0}:${holding.keys > 0 ? 1 : 0}`)
    .sort()
    .join(",");
}

/** Rebuild what can be rebuilt, mark what is lost (see the module comment). */
export async function applyRepair(
  deps: RepairDeps,
  row: Pick<StorageRepositoryRepair, "id" | "tenantId" | "requestedBy" | "scanId"> & {
    startedAt?: Date | null;
  },
): Promise<StorageRepositoryRepairResult> {
  // Restore mode after restoring a database dump (docs/STORAGE.md): a repair moves repositories
  // aside and deletes what it moved; a scan still runs, a repair waits.
  const decision = await deletionDecision({
    pass: "repository_repair_apply",
    tenantId: row.tenantId,
  });
  if (!decision.allowed) {
    throw new Error(
      "deleting is paused (restore mode after restoring a database dump): nothing was changed. Repair again once a provider owner has ended restore mode.",
    );
  }
  return withDeletionPermit({ pass: "repository_repair_apply", tenantId: row.tenantId }, () =>
    applyRepairWithPermit(deps, row),
  );
}

async function applyRepairWithPermit(
  deps: RepairDeps,
  row: Pick<StorageRepositoryRepair, "id" | "tenantId" | "requestedBy" | "scanId"> & {
    startedAt?: Date | null;
  },
): Promise<StorageRepositoryRepairResult> {
  const restic = deps.restic ?? realRepairRestic;
  const started = row.startedAt ?? deps.runtime.now();
  const [scan] = row.scanId
    ? await withTenantTx(deps.db, row.tenantId, (tx) =>
        tx
          .select()
          .from(storageRepositoryRepairs)
          .where(
            and(
              eq(storageRepositoryRepairs.id, row.scanId as string),
              eq(storageRepositoryRepairs.kind, "scan"),
              eq(storageRepositoryRepairs.status, "completed"),
            ),
          )
          .limit(1),
      )
    : [];
  if (!scan) {
    throw new Error("the repair names no completed scan of this tenant");
  }
  const unreadInScan = scan.result?.unreachable ?? [];
  if (unreadInScan.length > 0) {
    throw new Error(
      `the scan could not read ${unreadInScan.map((u) => `"${u.name}"`).join(", ")}: nothing was changed. Scan again once every storage target answers, then repair.`,
    );
  }
  const quiet = await quietTenant(deps, row.tenantId);
  if (quiet.blocker) {
    throw new Error(`${quiet.blocker}: nothing was changed. Repair again once it has ended.`);
  }
  const { sources, defaultUnreadable } = await sourcesOf(deps, row.tenantId);
  if (defaultUnreadable) {
    throw new Error(
      `the installation default could not be opened (${defaultUnreadable}): nothing was changed. Repair again once it answers.`,
    );
  }
  const scannedSources = scan.result?.sources ?? null;
  const missingSince =
    scannedSources?.filter((id) => !sources.some((source) => source.id === id)) ?? [];
  if (missingSince.length > 0) {
    throw new Error(
      "a storage target the scan read is no longer attached: nothing was changed. Scan again, then repair.",
    );
  }
  const primary = sources[0] as RepositorySource;
  const owners = await tenantRepositoryOwners(tenantRunner(deps.db, row.tenantId), row.tenantId);
  // Every place must answer now, optional ones included: the repair acts on what it sees.
  const { plans } = await planRepositoriesOf(owners, sources, primary, { unreachable: "strict" });
  const scanned = new Map(
    ((scan.result?.repositories ?? []) as StorageRepositoryScanEntry[]).map((entry) => [
      entry.prefix,
      entry,
    ]),
  );
  const runner = tenantRunner(deps.db, row.tenantId);
  const entries: StorageRepositoryRepairEntry[] = [];
  for (const plan of plans) {
    const base = {
      prefix: plan.owner.prefix,
      kind: plan.owner.kind,
      ownerId: plan.owner.ownerId,
      name: plan.owner.name,
    };
    const unchanged = (detail: string | null): StorageRepositoryRepairEntry => ({
      ...base,
      outcome: "unchanged",
      copied: 0,
      lostPoints: 0,
      movedTo: null,
      detail,
    });
    // A container a failed repair marked: complete on the primary now, it is checked again.
    let recheck = false;
    if (plan.class === "ok") {
      if (plan.owner.kind === "container") {
        const [guest] = await withTenantTx(deps.db, row.tenantId, (tx) =>
          tx
            .select({ problem: pveGuests.repositoryProblem })
            .from(pveGuests)
            .where(eq(pveGuests.id, plan.owner.ownerId))
            .limit(1),
        );
        recheck = guest?.problem?.type === PVE_REPOSITORY_REPAIR_FAILED;
        if (guest?.problem && !recheck) {
          await withTenantTx(deps.db, row.tenantId, (tx) =>
            tx
              .update(pveGuests)
              .set({ repositoryProblem: null })
              .where(eq(pveGuests.id, plan.owner.ownerId)),
          );
        }
      }
      if (!recheck) {
        entries.push(unchanged(null));
        continue;
      }
    }
    const confirmed = scanned.get(plan.owner.prefix);
    if (
      !recheck &&
      (!confirmed ||
        confirmed.class !== plan.class ||
        holdingsKey(confirmed.holdings) !== holdingsKey(plan.holdings))
    ) {
      entries.push(
        unchanged(
          `not what the confirmed scan found (${confirmed?.class ?? "not in it"}, now ${plan.class}): left as it is. Scan again and decide on what it shows.`,
        ),
      );
      continue;
    }
    const destructive =
      plan.owner.kind === "container" &&
      (plan.class === "data_only" || plan.class === "password_only");
    if (!repairable(plan) && !destructive && !recheck) {
      const active = await activePointsOf(runner, plan.owner);
      entries.push(
        unchanged(
          plan.class === "conflict"
            ? "two different repositories lie under this prefix, none on the primary: decide which one to keep"
            : plan.class === "missing"
              ? active > 0
                ? `on no storage target, ${active} restore point(s) refer to it: attach an old location that holds it and scan again, or reset the repository`
                : null
              : `incomplete (${plan.class}${active > 0 ? `, ${active} restore point(s) refer to it` : ""}): needs a decision`,
        ),
      );
      continue;
    }
    await deps.beforeRepository?.(plan.owner);
    // The primary must still be the one this repair planned on.
    const generation = await withTenantTx(deps.db, row.tenantId, (tx) =>
      storageGeneration(tx, row.tenantId),
    );
    if (generation !== quiet.generation) {
      throw new Error(
        "the storage targets of this tenant changed during the repair: it stopped. Scan again, then repair.",
      );
    }
    if (await machineRunning(deps, row.tenantId, plan.owner)) {
      entries.push(unchanged("a backup of this machine is running: repair again once it ended"));
      continue;
    }
    try {
      entries.push(
        await withEndpointRepositoryLock(
          deps.db.$client,
          repositoryLockKey(plan.owner),
          {
            mode: "exclusive",
            waitMs: deps.repositoryLockWaitMs ?? REPOSITORY_LOCK_WAIT_MS,
            pollMs: 500,
          },
          async () => {
            if (repairable(plan) || recheck) {
              return mergeOne(deps, row, plan, sources, restic, started);
            }
            // On write-once storage nothing is moved (or deleted): what lies there stays, and the
            // next backup begins under a fresh prefix next to it (docs/STORAGE.md).
            let kept = primary.writeOnce === true;
            const movedTo = kept
              ? null
              : await moveAside(primary.backend, plan.owner.prefix, deps.runtime.now()).catch(
                  (error: unknown) => {
                    if (isWriteRefused(error)) {
                      kept = true;
                      return null;
                    }
                    throw error;
                  },
                );
            const lostPoints = await markContainerPointsLost(
              deps,
              row.tenantId,
              plan.owner.ownerId,
              "all",
              row.requestedBy,
              true,
            );
            await audit(
              deps,
              row.tenantId,
              row.requestedBy,
              REPAIR_AUDIT_ACTIONS.lost,
              plan.owner.ownerId,
              "pve_guest",
              {
                repairId: row.id,
                prefix: plan.owner.prefix,
                class: plan.class,
                lostPoints,
                movedTo,
                keptOnWriteOnce: kept,
              },
            );
            return {
              ...base,
              outcome: lostPoints > 0 || kept ? ("lost" as const) : ("moved_aside" as const),
              copied: 0,
              lostPoints,
              movedTo,
              detail: null,
            };
          },
        ),
      );
    } catch (error) {
      entries.push({
        ...base,
        outcome: "failed",
        copied: 0,
        lostPoints: 0,
        movedTo: null,
        detail:
          error instanceof EndpointRepositoryBusyError
            ? "the repository is busy with retention, a check or a restore: repair again later"
            : error instanceof Error
              ? error.message.slice(0, 400)
              : String(error),
      });
    }
  }
  return { repositories: entries };
}

/** One pass over the queue: every queued scan or repair, oldest first. */
export async function repositoryRepairPass(deps: RepairDeps): Promise<number> {
  const queued = await deps.providerDb
    .select()
    .from(storageRepositoryRepairs)
    .where(eq(storageRepositoryRepairs.status, "queued"))
    .orderBy(asc(storageRepositoryRepairs.createdAt))
    .limit(10);
  let done = 0;
  for (const row of queued) {
    const [claimed] = await deps.providerDb
      .update(storageRepositoryRepairs)
      .set({ status: "running", startedAt: deps.runtime.now() })
      .where(
        and(eq(storageRepositoryRepairs.id, row.id), eq(storageRepositoryRepairs.status, "queued")),
      )
      .returning();
    if (!claimed) {
      continue;
    }
    try {
      const result =
        claimed.kind === "scan"
          ? await scanRepositories(deps, claimed)
          : await applyRepair(deps, claimed);
      await deps.providerDb
        .update(storageRepositoryRepairs)
        .set({ status: "completed", result, finishedAt: deps.runtime.now() })
        .where(eq(storageRepositoryRepairs.id, claimed.id));
    } catch (error) {
      deps.runtime.logger.error("repository repair failed", {
        tenantId: claimed.tenantId,
        repairId: claimed.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      await deps.providerDb
        .update(storageRepositoryRepairs)
        .set({
          status: "failed",
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          finishedAt: deps.runtime.now(),
        })
        .where(eq(storageRepositoryRepairs.id, claimed.id));
    }
    done += 1;
  }
  return done;
}

/**
 * Run a pass every 15 seconds while no other worker does (an advisory lock on the installation
 * pool); returns a stop function. A repair that was running when a worker stopped is queued
 * again at the start: every step is safe to repeat (copies are verified, a point once marked
 * lost stays so, a repository a first attempt already rebuilt is `ok` now and left alone).
 */
export function startRepositoryRepairs(
  deps: RepairDeps,
  intervalMs = PASS_INTERVAL_MS,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = () => {
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  let first = true;
  const tick = async () => {
    const client = await deps.providerDb.$client.connect().catch(() => null);
    if (!client) {
      schedule();
      return;
    }
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [LOCK_KEY],
      );
      if (!rows[0]?.locked) {
        return;
      }
      try {
        if (first) {
          first = false;
          await deps.providerDb
            .update(storageRepositoryRepairs)
            .set({ status: "queued" })
            .where(eq(storageRepositoryRepairs.status, "running"));
        }
        await repositoryRepairPass(deps);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    } catch (error) {
      deps.runtime.logger.error("repository repair pass failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      client.release();
      schedule();
    }
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}
