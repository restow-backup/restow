/**
 * The repository repair of a tenant (docs/STORAGE.md, "Repository repair"): for installations
 * whose restic repositories were split across storage targets, dropped with the installation
 * default by a promotion of 0.4.1, or silently replaced by a new chain.
 *
 * An administrator queues a scan (`storage_repository_repairs`, kind `scan`); this pass lists
 * every restic repository of the tenant on every place it may lie (the primary, the copies, the
 * retired targets, an old location attached read-only, the installation default) and classifies
 * it (storage-migration-restic.ts `planRepositories`). Nothing is changed.
 *
 * "Apply" (kind `apply`, queued with a recent sign-in and a typed confirmation, naming the scan
 * it was decided on) plans again from a fresh listing and, per repository:
 *
 *   - `elsewhere`, `split`: copies `config`, the keys and every content-addressed file the
 *     primary lacks onto it, each verified against its SHA-256 (the config against its source),
 *     then runs `restic check` (structure) and `restic snapshots` there. A container's restore
 *     points whose restic snapshot is not in the repository become unavailable ("lost");
 *   - a container's repository with no `config` or no key anywhere (`data_only`, `missing`):
 *     its restore points become unavailable ("lost"), what lies at its prefix on the primary is
 *     moved aside (never deleted), and the next backup begins a new chain;
 *   - everything else (two chains under one prefix, a lone password file, a machine's or a
 *     file share's incomplete repository) is listed and left as it is: an operator decides.
 *
 * Audited as `storage.repositories.scanned`, `storage.repository.merged` and
 * `storage.repository.lost`. One pass at a time across the installation (an advisory lock);
 * one scan or repair at a time per tenant (a unique index).
 */
import {
  INSTALLATION_DEFAULT_TARGET_ID,
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
  withRepository,
} from "@restow/core";
import {
  type Database,
  PVE_REPOSITORY_CHAINS_KEPT,
  pveGuests,
  pveSnapshots,
  type StorageRepositoryRepair,
  type StorageRepositoryRepairEntry,
  type StorageRepositoryScanEntry,
  storageRepositoryRepairs,
} from "@restow/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import { processDefaultStorage } from "../default-storage.js";
import {
  freshTenantStorage,
  PgSecretReader,
  tenantRunner,
  type WorkerRuntime,
  withTenantTx,
} from "./framework.js";
import {
  activePointsOf,
  planRepositories,
  type RepositoryPlan,
  type RepositorySource,
  tenantRepositoryOwners,
} from "./storage-migration-restic.js";

export const REPAIR_AUDIT_ACTIONS = {
  scanned: "storage.repositories.scanned",
  merged: "storage.repository.merged",
  lost: "storage.repository.lost",
} as const;

const PASS_INTERVAL_MS = 15_000;
const LOCK_KEY = 0x52455052; // "REPR"

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
}

/** Every place a repository of the tenant may lie, the primary first. */
async function sourcesOf(deps: RepairDeps, tenantId: string): Promise<RepositorySource[]> {
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
    });
  }
  if (!sources.some((known) => known.id === INSTALLATION_DEFAULT_TARGET_ID)) {
    const fallback = deps.installationDefault
      ? await deps.installationDefault()
      : await processDefaultStorage()
          .current()
          .then((current) => current.targets.primary)
          .catch(() => null);
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
  return sources;
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
): Promise<StorageRepositoryScanEntry[]> {
  const sources = await sourcesOf(deps, row.tenantId);
  const owners = await tenantRepositoryOwners(tenantRunner(deps.db, row.tenantId), row.tenantId);
  const entries = await scanEntries(deps, row.tenantId, await planRepositories(owners, sources));
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
    },
  );
  return entries;
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

/** Move every object under `prefix` aside to `<prefix>.orphaned-<time>/` (never deleted). */
async function moveAside(
  backend: StorageBackend,
  prefix: string,
  now: Date,
): Promise<string | null> {
  const keys = await backend.list(prefix);
  if (keys.length === 0) {
    return null;
  }
  const destination = `${prefix.replace(/\/$/, "")}.orphaned-${now.toISOString().replace(/[:.]/g, "-")}/`;
  for (const key of keys) {
    await backend.put(`${destination}${key.slice(prefix.length)}`, await backend.getStream(key));
    await backend.delete(key);
  }
  return destination;
}

/** A container's restore points: these become unavailable as lost (and its guest records it). */
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
              reason: "lost" as const,
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

/** Rebuild one complete-together repository on the primary (see the module comment). */
async function mergeOne(
  deps: RepairDeps,
  row: Pick<StorageRepositoryRepair, "id" | "tenantId" | "requestedBy">,
  plan: RepositoryPlan,
  sources: readonly RepositorySource[],
  restic: RepairRestic,
): Promise<StorageRepositoryRepairEntry> {
  const primary = sources[0] as RepositorySource;
  const base = {
    prefix: plan.owner.prefix,
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
  const problems: MirrorItemResult[] = [];
  let copied = 0;
  for (const item of plan.items) {
    const outcome = await mirrorItem(
      { source: reader, target: primary.backend, items: [], verify: "hash" },
      item,
    );
    if (outcome.outcome === "copied" || outcome.outcome === "repaired") {
      copied += 1;
    } else if (outcome.outcome !== "present") {
      problems.push(outcome);
    }
  }
  if (problems.length > 0) {
    return {
      ...base,
      outcome: "failed",
      copied,
      lostPoints: 0,
      movedTo: null,
      detail: `${problems.length} file(s) could not be copied and verified: ${problems
        .slice(0, 5)
        .map((problem) => `${problem.key} (${problem.outcome})`)
        .join(", ")}`,
    };
  }
  const password = await guestPassword(deps, row.tenantId, plan.owner.secretId);
  let lostPoints = 0;
  if (password) {
    const access: RepositoryAccess = {
      storage: primary.backend,
      prefix: plan.owner.prefix,
      repositoryPassword: password,
      repositoryKey: `repair-${row.id}-${plan.owner.ownerId}`,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    };
    let snapshots: string[];
    try {
      await restic.check(access);
      snapshots = await restic.snapshots(access);
    } catch (error) {
      return {
        ...base,
        outcome: "failed",
        copied,
        lostPoints: 0,
        movedTo: null,
        detail: `restic found the rebuilt repository not sound: ${resticErrorDetail(error, 400)}`,
      };
    }
    if (plan.owner.kind === "container") {
      const known = new Set(snapshots);
      const points = await withTenantTx(deps.db, row.tenantId, (tx) =>
        tx
          .select({ id: pveSnapshots.id, resticSnapshotId: pveSnapshots.resticSnapshotId })
          .from(pveSnapshots)
          .where(
            and(
              eq(pveSnapshots.guestId, plan.owner.ownerId),
              eq(pveSnapshots.kind, "ct"),
              eq(pveSnapshots.status, "active"),
            ),
          ),
      );
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
      prefix: plan.owner.prefix,
      class: plan.class,
      copied,
      lostPoints,
      checked: password !== null,
    },
  );
  return { ...base, outcome: "merged", copied, lostPoints, movedTo: null, detail: null };
}

/** Rebuild what can be rebuilt, mark what is lost (see the module comment). */
export async function applyRepair(
  deps: RepairDeps,
  row: Pick<StorageRepositoryRepair, "id" | "tenantId" | "requestedBy" | "scanId">,
): Promise<StorageRepositoryRepairEntry[]> {
  const restic = deps.restic ?? realRepairRestic;
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
  const sources = await sourcesOf(deps, row.tenantId);
  const primary = sources[0] as RepositorySource;
  const owners = await tenantRepositoryOwners(tenantRunner(deps.db, row.tenantId), row.tenantId);
  const plans = await planRepositories(owners, sources);
  const runner = tenantRunner(deps.db, row.tenantId);
  const entries: StorageRepositoryRepairEntry[] = [];
  for (const plan of plans) {
    const base = {
      prefix: plan.owner.prefix,
      kind: plan.owner.kind,
      ownerId: plan.owner.ownerId,
      name: plan.owner.name,
    };
    if (plan.class === "ok") {
      if (plan.owner.kind === "container") {
        await withTenantTx(deps.db, row.tenantId, (tx) =>
          tx
            .update(pveGuests)
            .set({ repositoryProblem: null })
            .where(eq(pveGuests.id, plan.owner.ownerId)),
        );
      }
      entries.push({
        ...base,
        outcome: "unchanged",
        copied: 0,
        lostPoints: 0,
        movedTo: null,
        detail: null,
      });
      continue;
    }
    if (repairable(plan)) {
      try {
        entries.push(await mergeOne(deps, row, plan, sources, restic));
      } catch (error) {
        entries.push({
          ...base,
          outcome: "failed",
          copied: 0,
          lostPoints: 0,
          movedTo: null,
          detail: error instanceof Error ? error.message.slice(0, 400) : String(error),
        });
      }
      continue;
    }
    const active = await activePointsOf(runner, plan.owner);
    if (
      plan.owner.kind === "container" &&
      (plan.class === "data_only" || plan.class === "missing" || plan.class === "password_only")
    ) {
      const movedTo = await moveAside(primary.backend, plan.owner.prefix, deps.runtime.now());
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
        },
      );
      entries.push({
        ...base,
        outcome: lostPoints > 0 ? "lost" : "moved_aside",
        copied: 0,
        lostPoints,
        movedTo,
        detail: null,
      });
      continue;
    }
    entries.push({
      ...base,
      outcome: "unchanged",
      copied: 0,
      lostPoints: 0,
      movedTo: null,
      detail:
        plan.class === "conflict"
          ? "two different repositories lie under this prefix, none on the primary: decide which one to keep"
          : plan.class === "missing"
            ? null
            : `incomplete (${plan.class}${active > 0 ? `, ${active} restore point(s) refer to it` : ""}): needs a decision`,
    });
  }
  return entries;
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
      const repositories =
        claimed.kind === "scan"
          ? await scanRepositories(deps, claimed)
          : await applyRepair(deps, claimed);
      await deps.providerDb
        .update(storageRepositoryRepairs)
        .set({ status: "completed", result: { repositories }, finishedAt: deps.runtime.now() })
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
 * lost stays so).
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
