/**
 * Immutable backups in the worker (docs/STORAGE.md, "Immutable backups"), run
 * inside the `retention` job of every tenant:
 *
 *   renewal       every repository with S3 Object Lock moves the retention of
 *                 everything still in use (catalogued packs, wrapped keys, the
 *                 locked objects of the tenant's restic repositories) to
 *                 now + period + buffer once the last complete pass is a day
 *                 short of the buffer old. Objects whose deletion was already
 *                 refused because of the lock are left out so they run out.
 *                 Keys go in sorted order and the pass records how far it got,
 *                 so an interrupted one continues there the next time.
 *   verification  a sample of objects written since the setting was turned on
 *                 is checked with the storage (HeadObject retention): an object
 *                 without lock, or in a weaker mode, is a warning on the page.
 *   deferred      rows of deletions refused by a lock are dropped once the
 *                 object is gone.
 *
 * A directory's deletion delay needs none of this: Restow computes it from the
 * file time and the setting's history.
 */
import {
  endpointPrefix,
  fileShareRepositoryPrefix,
  type ImmutableStorageBackend,
  immutableBackendOf,
  keyPrefix,
  listWithSizes,
  lockClassOf,
  lockUntil,
  RENEWAL_CONCURRENCY,
  type RenewalReport,
  renewalDue,
  renewalResumable,
  renewRetention,
  type StorageBackend,
  s3LockMode,
  spreadSample,
  verifyImmutability,
} from "@restow/core";
import {
  type Database,
  endpoints,
  fileShares,
  immutabilityDeferredDeletions,
  packs,
  pveGuests,
  type StorageTargetImmutabilityState,
  snapshots,
  storageTargets,
} from "@restow/db";
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { withTenantTx } from "./framework.js";
import type { RetentionTask } from "./retention.js";

/** Objects checked per verification: the newest packs and restore points, and restic snapshots. */
const SAMPLE_PACKS = 8;
const SAMPLE_MANIFESTS = 4;
const SAMPLE_RESTIC = 8;

/** `IMMUTABILITY_RENEWAL_CONCURRENCY`: retention requests in flight per target (default 32, at most 256). */
export function renewalConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.IMMUTABILITY_RENEWAL_CONCURRENCY ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 256) : RENEWAL_CONCURRENCY;
}

/**
 * Record a deletion `backend` refused because the object is still locked.
 * Nothing is recorded for a backend that is not an immutable target row.
 */
export async function recordDeferredDeletion(
  db: Database,
  tenantId: string,
  backend: StorageBackend,
  key: string,
  retainUntil: Date | null,
): Promise<void> {
  const targetId = immutableBackendOf(backend)?.targetId;
  if (!targetId) {
    return;
  }
  await withTenantTx(db, tenantId, (tx) =>
    tx
      .insert(immutabilityDeferredDeletions)
      .values({ tenantId, targetId, key, retainUntil })
      .onConflictDoUpdate({
        target: [immutabilityDeferredDeletions.targetId, immutabilityDeferredDeletions.key],
        set: {
          retainUntil,
          attempts: sql`${immutabilityDeferredDeletions.attempts} + 1`,
          updatedAt: new Date(),
        },
      }),
  );
}

/** When the current Object Lock setting began: the last history entry that turned it on. */
function lockedSince(backend: ImmutableStorageBackend): Date | null {
  const history = backend.settings.history;
  let since: Date | null = null;
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (!entry || s3LockMode(entry.mode) === null || entry.days <= 0) {
      break;
    }
    since = new Date(entry.since);
  }
  return since;
}

interface TenantRepositories {
  readonly prefixes: string[];
}

async function resticPrefixes(db: Database, tenantId: string): Promise<TenantRepositories> {
  return withTenantTx(db, tenantId, async (tx) => {
    const machine = await tx.select({ id: endpoints.id }).from(endpoints);
    const shares = await tx.select({ id: fileShares.id }).from(fileShares);
    const guests = await tx.select({ id: pveGuests.id }).from(pveGuests);
    return {
      prefixes: [
        ...machine.map((row) => endpointPrefix(row.id)),
        ...shares.map((row) => fileShareRepositoryPrefix(row.id)),
        ...guests.map((row) => `pve-guests/${row.id}/`),
      ],
    };
  });
}

async function deferredKeys(
  db: Database,
  tenantId: string,
  targetId: string,
): Promise<Set<string>> {
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ key: immutabilityDeferredDeletions.key })
      .from(immutabilityDeferredDeletions)
      .where(eq(immutabilityDeferredDeletions.targetId, targetId)),
  );
  return new Set(rows.map((row) => row.key));
}

/** The locked objects of every restic repository of the tenant on `backend`, minus `skip`. */
async function resticKeys(
  backend: StorageBackend,
  repositories: TenantRepositories,
  skip: ReadonlySet<string>,
): Promise<string[]> {
  const keys: string[] = [];
  for (const prefix of repositories.prefixes) {
    for (const entry of await listWithSizes(backend, prefix)) {
      if (lockClassOf(entry.key) === "backup" && !skip.has(entry.key)) {
        keys.push(entry.key);
      }
    }
  }
  return keys;
}

export interface ImmutabilityTargetSummary {
  readonly targetId: string;
  readonly renewed: boolean;
  readonly renewal: Omit<RenewalReport, "missing" | "failed" | "resumeAfter"> | null;
  readonly verification: { sampled: number; unlocked: number; weakerMode: number } | null;
  readonly deferredCleared: number;
}

/** Renew, verify and tidy up one immutable target. */
export async function maintainImmutableTarget(options: {
  readonly db: Database;
  readonly tenantId: string;
  readonly backend: ImmutableStorageBackend;
  readonly now: Date;
  readonly signal?: AbortSignal;
  /** Renew even when the last pass is recent (the "Verify now" button never does). */
  readonly forceRenewal?: boolean;
  readonly renew?: boolean;
  /** Retention requests in flight (default {@link renewalConcurrency}). */
  readonly concurrency?: number;
  /** How many keys pass between two saves of the resume point (tests). */
  readonly progressEvery?: number;
}): Promise<ImmutabilityTargetSummary> {
  const { db, tenantId, backend, now } = options;
  const targetId = backend.targetId as string;
  const [row] = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ state: storageTargets.immutabilityState })
      .from(storageTargets)
      .where(eq(storageTargets.id, targetId))
      .limit(1),
  );
  const state: StorageTargetImmutabilityState = { ...(row?.state ?? {}) };
  const lockMode = backend.lockMode;
  const since = lockedSince(backend);
  let renewed = false;
  let renewal: ImmutabilityTargetSummary["renewal"] = null;
  const repositories = await resticPrefixes(db, tenantId);
  const skip = await deferredKeys(db, tenantId, targetId);

  const lastRenewal = state.renewedAt ? new Date(state.renewedAt) : null;
  if (
    lockMode &&
    backend.active &&
    options.renew !== false &&
    (options.forceRenewal || renewalDue(lastRenewal, now))
  ) {
    const packPaths = await withTenantTx(db, tenantId, (tx) =>
      tx.select({ path: packs.path }).from(packs).where(eq(packs.tenantId, tenantId)),
    );
    const keys = [
      ...packPaths.map((pack) => pack.path).filter((path) => !skip.has(path)),
      ...(await backend.list(keyPrefix(tenantId))),
      ...(await resticKeys(backend, repositories, skip)),
    ];
    // Continue an unfinished pass where it stopped, as if it had not been interrupted.
    const resumed =
      state.renewalProgress && renewalResumable(new Date(state.renewalProgress.startedAt), now)
        ? state.renewalProgress
        : null;
    const startedAt = resumed ? resumed.startedAt : now.toISOString();
    const until = resumed ? new Date(resumed.until) : lockUntil(now, backend.settings.days);
    const report = await renewRetention(backend, keys, until, {
      ...(options.signal ? { signal: options.signal } : {}),
      concurrency: options.concurrency ?? renewalConcurrency(),
      after: resumed?.after ?? null,
      ...(options.progressEvery ? { progressEvery: options.progressEvery } : {}),
      onProgress: (after) =>
        saveRenewalProgress(db, tenantId, targetId, {
          startedAt,
          until: until.toISOString(),
          after,
        }),
    });
    const complete = report.failedTotal === 0 && !options.signal?.aborted;
    state.renewal = {
      at: now.toISOString(),
      extended: report.extended,
      alreadyLonger: report.alreadyLonger,
      missing: report.missing.length,
      failed: report.failedTotal,
      complete,
    };
    if (complete) {
      state.renewedAt = startedAt;
      state.renewalProgress = null;
      renewed = true;
    } else if (report.resumeAfter !== null) {
      state.renewalProgress = { startedAt, until: until.toISOString(), after: report.resumeAfter };
    }
    renewal = {
      extended: report.extended,
      alreadyLonger: report.alreadyLonger,
      failedTotal: report.failedTotal,
      until: report.until,
    };
  }

  let verification: ImmutabilityTargetSummary["verification"] = null;
  if (lockMode && backend.active && since) {
    const sample = await verificationSample(
      db,
      tenantId,
      backend,
      repositories,
      skip,
      since,
      state,
    );
    const report = await verifyImmutability(backend, sample, now);
    state.verification = { ...report, problems: [...report.problems] };
    verification = {
      sampled: report.sampled,
      unlocked: report.unlocked,
      weakerMode: report.weakerMode,
    };
  }

  // Deferred deletions whose object is gone (restic or the scrub removed it after the lock).
  let deferredCleared = 0;
  const expired = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ id: immutabilityDeferredDeletions.id, key: immutabilityDeferredDeletions.key })
      .from(immutabilityDeferredDeletions)
      .where(
        and(
          eq(immutabilityDeferredDeletions.targetId, targetId),
          isNotNull(immutabilityDeferredDeletions.retainUntil),
          lt(immutabilityDeferredDeletions.retainUntil, now),
        ),
      ),
  );
  for (const entry of expired) {
    if ((await backend.head(entry.key)) === null) {
      await withTenantTx(db, tenantId, (tx) =>
        tx
          .delete(immutabilityDeferredDeletions)
          .where(eq(immutabilityDeferredDeletions.id, entry.id)),
      );
      deferredCleared++;
    }
  }

  await withTenantTx(db, tenantId, (tx) =>
    tx
      .update(storageTargets)
      .set({ immutabilityState: state })
      .where(eq(storageTargets.id, targetId)),
  );
  return { targetId, renewed, renewal, verification, deferredCleared };
}

/** Record how far a renewal pass got, without touching the rest of the state. */
async function saveRenewalProgress(
  db: Database,
  tenantId: string,
  targetId: string,
  progress: NonNullable<StorageTargetImmutabilityState["renewalProgress"]>,
): Promise<void> {
  await withTenantTx(db, tenantId, (tx) =>
    tx
      .update(storageTargets)
      .set({
        immutabilityState: sql`coalesce(${storageTargets.immutabilityState}, '{}'::jsonb) || jsonb_build_object('renewalProgress', ${JSON.stringify(progress)}::jsonb)`,
      })
      .where(eq(storageTargets.id, targetId)),
  );
}

/**
 * Objects that must be locked now: the newest packs and committed manifests
 * written since Object Lock was turned on, and (once a renewal has run)
 * snapshot files of the restic repositories.
 */
async function verificationSample(
  db: Database,
  tenantId: string,
  backend: ImmutableStorageBackend,
  repositories: TenantRepositories,
  skip: ReadonlySet<string>,
  since: Date,
  state: StorageTargetImmutabilityState,
): Promise<string[]> {
  const { newestPacks, newestManifests } = await withTenantTx(db, tenantId, async (tx) => ({
    newestPacks: await tx
      .select({ path: packs.path })
      .from(packs)
      .where(and(eq(packs.tenantId, tenantId), gte(packs.createdAt, since)))
      .orderBy(desc(packs.createdAt))
      .limit(SAMPLE_PACKS),
    newestManifests: await tx
      .select({ path: snapshots.manifestPath })
      .from(snapshots)
      .where(
        and(
          eq(snapshots.tenantId, tenantId),
          eq(snapshots.status, "active"),
          isNotNull(snapshots.completedAt),
          isNotNull(snapshots.manifestPath),
          gte(snapshots.completedAt, since),
        ),
      )
      .orderBy(desc(snapshots.completedAt))
      .limit(SAMPLE_MANIFESTS),
  }));
  const keys = [
    ...newestPacks.map((row) => row.path),
    ...newestManifests.map((row) => row.path as string),
  ].filter((key) => !skip.has(key));
  if (state.renewedAt) {
    // After a complete renewal every object still in use is locked, old ones included.
    const restic: string[] = [];
    for (const prefix of repositories.prefixes) {
      for (const key of await backend.list(`${prefix}snapshots/`)) {
        if (!skip.has(key)) {
          restic.push(key);
        }
      }
    }
    keys.push(...spreadSample(restic, SAMPLE_RESTIC));
  }
  return keys;
}

/** The retention task: every immutable S3 target of the tenant. */
export const immutabilityTask: RetentionTask = {
  name: "immutability",

  async run(ctx, options): Promise<Record<string, unknown>> {
    const logger = ctx.logger.child({ task: "immutability" });
    const targets: StorageBackend[] = [ctx.storage.primary, ...ctx.storage.copies];
    const summaries: ImmutabilityTargetSummary[] = [];
    let errors = 0;
    const seen = new Set<string>();
    for (const target of targets) {
      const backend = immutableBackendOf(target);
      if (!backend?.targetId || seen.has(backend.targetId) || options.dryRun) {
        continue;
      }
      seen.add(backend.targetId);
      try {
        summaries.push(
          await maintainImmutableTarget({
            db: ctx.db,
            tenantId: ctx.tenantId,
            backend,
            now: ctx.now(),
            signal: ctx.signal,
          }),
        );
      } catch (error) {
        errors++;
        logger.warn("immutable backups: renewal or verification failed", {
          targetId: backend.targetId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (summaries.some((summary) => (summary.verification?.unlocked ?? 0) > 0)) {
      logger.warn("immutable backups: objects written without Object Lock", {
        targets: summaries
          .filter((summary) => (summary.verification?.unlocked ?? 0) > 0)
          .map((summary) => summary.targetId),
      });
    }
    return { targets: summaries, errors, dryRun: options.dryRun };
  },
};
