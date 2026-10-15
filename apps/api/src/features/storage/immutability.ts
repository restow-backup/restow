import {
  changeImmutability,
  type ImmutabilityMode,
  type ImmutabilitySettings,
  immutableBackendOf,
  lowersImmutability,
  type ObjectLockCapability,
  openStorageTarget,
  type StorageBackend,
  s3LockMode,
  verifyImmutability,
} from "@restow/core";
import {
  type Database,
  immutabilityDeferredDeletions,
  packs,
  type StorageTarget,
  type StorageTargetImmutabilityState,
  snapshots,
  storageTargets,
} from "@restow/db";
import { and, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { assertRecentSignIn, type SessionTimes } from "../../lib/recent-sign-in.js";
import { readSecret } from "../../lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { forgetTenantStorage } from "../endpoints/repository.js";
import { resolveTenantStorage } from "../restore/storage.js";
import type { Viewer } from "../snapshots/access.js";
import { loadSnapshotForViewer } from "../snapshots/service.js";
import { locationOf } from "./dto.js";
import { type ImmutabilityDto, settingsOf, toImmutabilityDto } from "./immutability-dto.js";

/**
 * Immutable backups on a repository (docs/STORAGE.md, "Immutable backups"):
 * the setting, what the worker last found out, and a restore point's
 * protection as the storage reports it.
 *
 * Raising the protection (more days, from off to on, GOVERNANCE to COMPLIANCE)
 * is open to whoever may configure the repository. Lowering it is for the
 * provider owner with a recent sign-in only, and never reaches back: S3 keeps
 * every retention already set, and the deletion delay of a directory follows
 * the stored history.
 */

export const IMMUTABILITY_AUDIT_ACTIONS = {
  changed: "storage.target.immutability_changed",
  verified: "storage.target.immutability_verified",
} as const;

const PROBLEM = "urn:restow:problem:storage-immutability-";

/** Who changes it: the storage feature's actor plus the provider role and session age. */
export interface ImmutabilityActor {
  readonly id: string;
  readonly email: string;
  readonly ip: string | null;
  readonly isProviderAdmin: boolean;
  /** A provider admin with the owner role. */
  readonly isProviderOwner: boolean;
  readonly session: SessionTimes;
}

/** Pending deferred deletions per target of a tenant. */
export async function deferredDeletionCounts(
  tx: DbExecutor,
  tenantId: string,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({ targetId: immutabilityDeferredDeletions.targetId, n: count() })
    .from(immutabilityDeferredDeletions)
    .where(eq(immutabilityDeferredDeletions.tenantId, tenantId))
    .groupBy(immutabilityDeferredDeletions.targetId);
  return new Map(rows.map((row) => [row.targetId, Number(row.n)]));
}

export interface SetImmutabilityInput {
  mode: ImmutabilityMode | null;
  days: number;
}

export interface ImmutabilityChangeDeps {
  readonly now?: () => Date;
  /** Object Lock detection (tests); the bucket is asked otherwise. */
  readonly detect?: (row: StorageTarget) => Promise<ObjectLockCapability>;
}

function problem(
  status: 403 | 404 | 409 | 422,
  title: string,
  reason: string,
  detail: string,
  extra = {},
) {
  return new ProblemError(status, title, {
    type: `${PROBLEM}${reason}`,
    detail,
    extensions: { reason, ...extra },
  });
}

async function loadRow(tx: DbExecutor, tenantId: string, id: string): Promise<StorageTarget> {
  const [row] = await tx
    .select()
    .from(storageTargets)
    .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, id)))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Storage target not found");
  }
  return row;
}

async function detectFor(
  db: Database,
  tenantId: string,
  row: StorageTarget,
): Promise<ObjectLockCapability> {
  const location = locationOf(row);
  if (location?.kind !== "s3") {
    throw problem(
      422,
      "Invalid storage target",
      "invalid-location",
      "The repository's address is not valid.",
    );
  }
  const opened = await openStorageTarget(
    { ...row, immutability: null },
    { get: (secretId) => readSecret(db, { id: secretId, tenantId }) },
    { purpose: "probe" },
  );
  return opened.detectObjectLock();
}

/**
 * Change a repository's immutability (see the module comment for who may do
 * what). Turning on or raising Object Lock asks the bucket first and refuses a
 * bucket without Object Lock.
 */
export async function setImmutability(
  db: Database,
  tenantId: string,
  id: string,
  input: SetImmutabilityInput,
  actor: ImmutabilityActor,
  deps: ImmutabilityChangeDeps = {},
): Promise<{ immutability: ImmutabilityDto; objectLock: ObjectLockCapability | null }> {
  const now = deps.now?.() ?? new Date();
  const row = await withTenantTx(db, tenantId, (tx) => loadRow(tx, tenantId, id));
  if (row.kind === "local" && !actor.isProviderAdmin) {
    // A directory is part of the server: like every other change of one, provider admins only.
    throw problem(
      403,
      "Forbidden",
      "local-requires-provider",
      "Only a provider administrator can change a directory repository.",
    );
  }
  if (row.kind === "installation_default" || row.role === "previous") {
    throw problem(
      409,
      "Not possible here",
      "not-writable",
      "This location is no longer written to; immutability applies to what is written from now on.",
    );
  }
  const next: SetImmutabilityInput =
    input.mode === null ? { mode: null, days: 0 } : { mode: input.mode, days: input.days };
  if (next.mode !== null) {
    const allowed: readonly ImmutabilityMode[] =
      row.kind === "s3" ? ["compliance", "governance"] : ["delayed_deletion"];
    if (!allowed.includes(next.mode)) {
      throw problem(
        422,
        "Mode not available",
        "mode-not-available",
        row.kind === "s3"
          ? "An S3 repository is protected with Object Lock (COMPLIANCE or GOVERNANCE)."
          : "A directory cannot be made immutable; only the deletion delay is available.",
      );
    }
  }
  const current = settingsOf(row);
  if ((current?.mode ?? null) === next.mode && (current?.days ?? 0) === next.days) {
    return { immutability: toImmutabilityDto(row, 0, actor, now), objectLock: null };
  }
  const lowering = lowersImmutability(current, next);
  if (lowering) {
    if (!actor.isProviderOwner) {
      throw problem(
        403,
        "Only the provider owner can lower immutability",
        "lowering-forbidden",
        "Lowering or switching off immutability is reserved for the provider owner, with a recent sign-in. It only applies to what is written from then on.",
      );
    }
    assertRecentSignIn(actor.session, now);
  }

  let objectLock: ObjectLockCapability | null = null;
  if (next.mode !== null && s3LockMode(next.mode) !== null) {
    objectLock = await (deps.detect ?? ((target) => detectFor(db, tenantId, target)))(row);
    if (objectLock.status !== "enabled") {
      throw problem(
        409,
        "The bucket has no Object Lock",
        "object-lock-unavailable",
        "This bucket does not enforce Object Lock, so its backups cannot be made immutable. Object Lock can only be enabled when a bucket is created: create a bucket with Object Lock and add it as a repository or a copy.",
        { objectLock },
      );
    }
  }

  const settings = changeImmutability(current, next, now);
  const { saved, deferred } = await withTenantTx(db, tenantId, async (tx) => {
    const [saved] = await tx
      .update(storageTargets)
      .set({
        immutability: {
          mode: settings.mode,
          days: settings.days,
          history: settings.history.map((entry) => ({ ...entry })),
        },
      })
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, id)))
      .returning();
    if (!saved) {
      throw new ProblemError(404, "Storage target not found");
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: IMMUTABILITY_AUDIT_ACTIONS.changed,
      target: id,
      targetType: "storage_target",
      ip: actor.ip,
      details: {
        before: { mode: current?.mode ?? null, days: current?.days ?? 0 },
        after: { mode: settings.mode, days: settings.days },
        lowered: lowering,
        kind: row.kind,
        objectLock: objectLock
          ? {
              status: objectLock.status,
              mode: objectLock.mode,
              defaultDays: objectLock.defaultRetentionDays,
            }
          : null,
      },
    });
    return { saved, deferred: (await deferredDeletionCounts(tx, tenantId)).get(id) ?? 0 };
  });
  // The api's own restic and restore paths pick the new setting up at once.
  forgetTenantStorage(tenantId);
  return { immutability: toImmutabilityDto(saved, deferred, actor, now), objectLock };
}

/** Objects a verification samples: the newest packs and restore points since Object Lock was on. */
async function sampleKeys(tx: DbExecutor, tenantId: string, since: Date): Promise<string[]> {
  const newestPacks = await tx
    .select({ path: packs.path })
    .from(packs)
    .where(and(eq(packs.tenantId, tenantId), gte(packs.createdAt, since)))
    .orderBy(desc(packs.createdAt))
    .limit(8);
  const newestManifests = await tx
    .select({ path: snapshots.manifestPath })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        eq(snapshots.status, "active"),
        isNotNull(snapshots.manifestPath),
        isNotNull(snapshots.completedAt),
        gte(snapshots.completedAt, since),
      ),
    )
    .orderBy(desc(snapshots.completedAt))
    .limit(4);
  return [
    ...newestPacks.map((row) => row.path),
    ...newestManifests.map((row) => row.path as string),
  ];
}

/** The start of the current Object Lock setting. */
function objectLockSince(settings: ImmutabilitySettings): Date | null {
  let since: Date | null = null;
  for (let index = settings.history.length - 1; index >= 0; index--) {
    const entry = settings.history[index];
    if (!entry || s3LockMode(entry.mode) === null || entry.days <= 0) {
      break;
    }
    since = new Date(entry.since);
  }
  return since;
}

/** "Verify now": ask the storage for the retention of a sample, keep and audit the result. */
export async function verifyImmutabilityNow(
  db: Database,
  tenantId: string,
  id: string,
  actor: Pick<ImmutabilityActor, "id" | "email" | "ip" | "isProviderOwner">,
  deps: {
    readonly now?: () => Date;
    readonly open?: (row: StorageTarget) => Promise<StorageBackend>;
  } = {},
): Promise<ImmutabilityDto> {
  const now = deps.now?.() ?? new Date();
  const { row, keys } = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadRow(tx, tenantId, id);
    const settings = settingsOf(row);
    const since = settings?.mode && s3LockMode(settings.mode) ? objectLockSince(settings) : null;
    return { row, keys: since ? await sampleKeys(tx, tenantId, since) : null };
  });
  if (keys === null) {
    throw problem(
      409,
      "Nothing to verify",
      "not-object-lock",
      "Only a repository with S3 Object Lock is verified with the storage.",
    );
  }
  const backend = deps.open
    ? await deps.open(row)
    : (
        await openStorageTarget(row, {
          get: (secretId) => readSecret(db, { id: secretId, tenantId }),
        })
      ).backend;
  const immutable = immutableBackendOf(backend);
  if (!immutable) {
    throw problem(409, "Nothing to verify", "not-object-lock", "This repository is not immutable.");
  }
  const report = await verifyImmutability(immutable, keys, now);
  return withTenantTx(db, tenantId, async (tx) => {
    const state: StorageTargetImmutabilityState = {
      ...(row.immutabilityState ?? {}),
      verification: { ...report, problems: [...report.problems] },
    };
    const [saved] = await tx
      .update(storageTargets)
      .set({ immutabilityState: state })
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, id)))
      .returning();
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: IMMUTABILITY_AUDIT_ACTIONS.verified,
      target: id,
      targetType: "storage_target",
      ip: actor.ip,
      details: {
        sampled: report.sampled,
        locked: report.locked,
        unlocked: report.unlocked,
        weakerMode: report.weakerMode,
        missing: report.missing,
        errors: report.errors,
      },
    });
    const deferred = (await deferredDeletionCounts(tx, tenantId)).get(id) ?? 0;
    return toImmutabilityDto(saved ?? row, deferred, actor, now);
  });
}

// ---------------------------------------------------------------------------
// A restore point's protection
// ---------------------------------------------------------------------------

export interface RestorePointImmutabilityDto {
  /**
   * `immutable`: a target's storage reported a COMPLIANCE retention beyond now
   * (green); `governance`: only GOVERNANCE (a principal with the bypass
   * permission can lift it); `delayed`: only a directory's deletion delay
   * (Restow's own promise); `none`: nothing protects it.
   */
  state: "immutable" | "governance" | "delayed" | "none";
  /** The latest protection end of the reported state. */
  until: string | null;
  targets: {
    targetId: string | null;
    source: "object_lock" | "deletion_delay";
    mode: "GOVERNANCE" | "COMPLIANCE" | null;
    until: string | null;
    exists: boolean;
  }[];
  checkedAt: string;
}

/** Ask every immutable target of the tenant how it protects `key` right now. */
export async function protectionOf(
  backends: readonly StorageBackend[],
  key: string,
  now: Date,
): Promise<RestorePointImmutabilityDto> {
  const targets: RestorePointImmutabilityDto["targets"] = [];
  for (const backend of backends) {
    const immutable = immutableBackendOf(backend);
    if (!immutable) {
      continue;
    }
    const protection = await immutable.protection(key);
    targets.push({
      targetId: immutable.targetId,
      source: protection.source,
      mode: protection.mode,
      until: protection.until?.toISOString() ?? null,
      exists: protection.exists,
    });
  }
  const best = (match: (entry: (typeof targets)[number]) => boolean) =>
    targets
      .filter((entry) => entry.until !== null && match(entry))
      .map((entry) => entry.until as string)
      .sort()
      .at(-1) ?? null;
  const compliance = best((entry) => entry.source === "object_lock" && entry.mode === "COMPLIANCE");
  const governance = best((entry) => entry.source === "object_lock");
  const delayed = best((entry) => entry.source === "deletion_delay");
  const state = compliance ? "immutable" : governance ? "governance" : delayed ? "delayed" : "none";
  return {
    state,
    until: compliance ?? governance ?? delayed,
    targets,
    checkedAt: now.toISOString(),
  };
}

/** A mail/M365/PVE restore point's protection, from its manifest on every target. */
export async function restorePointImmutability(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  snapshotId: string,
  deps: {
    readonly now?: () => Date;
    readonly storage?: () => Promise<{
      primary: StorageBackend;
      copies: readonly StorageBackend[];
    }>;
  } = {},
): Promise<RestorePointImmutabilityDto> {
  const now = deps.now?.() ?? new Date();
  const loaded = await withTenantTx(db, tenantId, (tx) =>
    loadSnapshotForViewer(tx, tenantId, viewer, snapshotId),
  );
  const storage = deps.storage ? await deps.storage() : await resolveTenantStorage(db, tenantId);
  const path = loaded.snapshot.manifestPath;
  if (!path) {
    return { state: "none", until: null, targets: [], checkedAt: now.toISOString() };
  }
  return protectionOf([storage.primary, ...storage.copies], path, now);
}

/** A restic restore point's protection (an endpoint's), from its snapshot file on every target. */
export async function resticRestorePointImmutability(
  db: Database,
  tenantId: string,
  prefix: string,
  snapshotId: string,
  deps: {
    readonly now?: () => Date;
    readonly storage?: () => Promise<{
      primary: StorageBackend;
      copies: readonly StorageBackend[];
    }>;
  } = {},
): Promise<RestorePointImmutabilityDto> {
  const now = deps.now?.() ?? new Date();
  const storage = deps.storage ? await deps.storage() : await resolveTenantStorage(db, tenantId);
  return protectionOf(
    [storage.primary, ...storage.copies],
    `${prefix}snapshots/${snapshotId}`,
    now,
  );
}
