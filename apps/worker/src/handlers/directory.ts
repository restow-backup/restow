/**
 * `directory` queue: Entra directory sync for one M365 source.
 *
 * The engine lives in @restow/core (directory/sync.ts) and never touches the
 * database; this handler supplies what it needs from Postgres and the process
 * environment: the Graph client for the source's customer tenant and a
 * repository that loads the directory state from `sources.config` and
 * `protected_objects`, and commits one run (users, objects, orphans, delta
 * link) in a single tenant-pinned transaction. The outcome (counts, warnings,
 * or the failure reason) is written back to the source so the UI shows it
 * without reading job logs. While the run goes on, its phase and every wait
 * Microsoft Graph imposes are kept in `jobs.payload.runtime` (the backup
 * handler's PhaseRecorder), so the directory view can show the pause.
 *
 * A run enumerates the whole directory when there is no delta link yet, when
 * an admin asked for it, and at least every DIRECTORY_FULL_SYNC_HOURS; in
 * between it reads only the changes.
 *
 * The backup app registration is resolved when the Graph client is built,
 * exactly as the backup handler does it (../entra-app.ts): the environment's
 * ENTRA_CLIENT_* when set, otherwise the registration saved under Settings →
 * Microsoft 365. A source may carry its own client secret in `secret_ref`,
 * which takes precedence.
 *
 * Environment:
 *   DIRECTORY_FULL_SYNC_HOURS  hours between full enumerations (default 24)
 */
import { randomUUID } from "node:crypto";
import {
  type BackupJobPayload,
  ClientCredentialsTokenProvider,
  type DirectoryCommit,
  DirectoryConflictError,
  type DirectoryJobPayload,
  type DirectoryLastRun,
  type DirectoryPlan,
  type DirectoryRepository,
  type DirectorySnapshot,
  type DirectorySyncResult,
  FULL_SYNC_INTERVAL_MS,
  type FailureRecord,
  FetchGraphClient,
  type FirstBackupCandidate,
  type GraphClient,
  JobAbortedError,
  type KnownObject,
  type Logger,
  type NewlyActiveObject,
  type PlannedObject,
  type ThrottleInfo,
  capWarnings,
  fullSyncReason,
  protectionVersion,
  readDirectoryState,
  readProtection,
  selectFirstBackupTargets,
  syncDirectory,
  toTokenCallback,
  writeDirectoryState,
} from "@restow/core";
import {
  type FailureRecordJson,
  type Source,
  jobs,
  protectedObjects,
  safeErrorMessage,
  snapshots,
  sources,
  users,
} from "@restow/db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { appendAuditEntry } from "../audit.js";
import { type EntraAppLookup, processEntraApp } from "../entra-app.js";
import { jobFailureRecord } from "../failure.js";
import { pgBossExecutor } from "../pg-boss-tx.js";
import type { TenantTx, TenantTxRunner } from "../progress.js";
import { sendOptionsFor } from "../queues.js";
import {
  PhaseRecorder,
  RUNTIME_KEY,
  appCredentialsForSource,
  bossFor,
  mergeJobPayload,
} from "./backup.js";
import {
  InvalidPayloadError,
  type JobHandler,
  type WorkerJobContext,
  tenantRunner,
} from "./framework.js";

type Env = Record<string, string | undefined>;

/** Rows per statement for batched reads and writes. */
const ROW_BATCH = 500;

/**
 * Builds the Graph client for a source, reporting every throttling wait to
 * `throttled`; injectable so tests use the fake Graph.
 */
export type GraphClientFactory = (
  source: Source,
  ctx: WorkerJobContext,
  throttled: (info: ThrottleInfo) => void,
) => Promise<GraphClient>;

export interface DirectoryHandlerDeps {
  readonly graphClientFor: GraphClientFactory;
  /** Longest time between full enumerations. */
  readonly fullSyncIntervalMs?: number;
}

function chunks<T>(items: readonly T[], size = ROW_BATCH): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** DIRECTORY_FULL_SYNC_HOURS as milliseconds; invalid values fall back to the default. */
export function fullSyncIntervalFrom(env: Env): number {
  const hours = Number(env.DIRECTORY_FULL_SYNC_HOURS?.trim());
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : FULL_SYNC_INTERVAL_MS;
}

/** Client-credentials Graph client for the source's customer tenant. */
export async function graphClientForSource(
  source: Source,
  ctx: WorkerJobContext,
  throttled: (info: ThrottleInfo) => void,
  entraApp: EntraAppLookup = processEntraApp,
): Promise<GraphClient> {
  if (!source.entraTenantId) {
    throw new InvalidPayloadError(
      `source "${source.name}" has no Entra tenant id; admin consent is outstanding`,
    );
  }
  // A missing or unusable registration is configuration, not a transient
  // failure: it is rejected without retry (InvalidPayloadError).
  const app = await appCredentialsForSource({ ctx, source }, { entraApp });
  const tokens = new ClientCredentialsTokenProvider({ tenantId: source.entraTenantId, app });
  return new FetchGraphClient({
    accessTokenProvider: toTokenCallback(tokens),
    onThrottle: throttled,
  });
}

// ---------------------------------------------------------------------------
// Postgres repository
// ---------------------------------------------------------------------------

async function selectSource(
  tx: TenantTx,
  tenantId: string,
  sourceId: string,
  lock: boolean,
): Promise<Source> {
  const query = tx
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.id, sourceId)));
  const [row] = await (lock ? query.for("update") : query).limit(1);
  if (!row) {
    throw new Error(`source ${sourceId} no longer exists`);
  }
  return row;
}

/** Unique violation, possibly wrapped by the driver layer. */
function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return (candidate?.code ?? candidate?.cause?.code) === "23505";
}

/** Loads and commits the directory of one source. */
export class PgDirectoryRepository implements DirectoryRepository {
  constructor(
    private readonly run: TenantTxRunner,
    private readonly tenantId: string,
    private readonly sourceId: string,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<DirectorySnapshot> {
    return this.run(async (tx) => {
      const source = await selectSource(tx, this.tenantId, this.sourceId, false);
      const rows = await tx
        .select({
          externalId: protectedObjects.externalId,
          kind: protectedObjects.kind,
          status: protectedObjects.status,
          origin: protectedObjects.origin,
          displayName: protectedObjects.displayName,
          ownerId: users.entraObjectId,
          ownerUpn: users.upn,
          ownerEmail: users.email,
        })
        .from(protectedObjects)
        .leftJoin(users, eq(protectedObjects.userId, users.id))
        .where(
          and(
            eq(protectedObjects.tenantId, this.tenantId),
            eq(protectedObjects.sourceId, this.sourceId),
            ne(protectedObjects.kind, "imap"),
          ),
        );
      const known: KnownObject[] = rows.flatMap((row) =>
        row.kind === "imap"
          ? []
          : [
              {
                externalId: row.externalId,
                kind: row.kind,
                status: row.status,
                origin: row.origin,
                displayName: row.displayName,
                owner:
                  row.ownerId && row.ownerEmail
                    ? { entraObjectId: row.ownerId, upn: row.ownerUpn, email: row.ownerEmail }
                    : null,
              },
            ],
      );
      const state = readDirectoryState(source.config);
      return {
        deltaLink: state.deltaLink,
        known,
        sharedOrBlockedIds: new Set(state.sharedOrBlockedIds),
        protection: readProtection(source.config),
        version: protectionVersion(source.config),
      };
    });
  }

  async commit(commit: DirectoryCommit, expectedVersion: string): Promise<void> {
    await this.run(async (tx) => {
      // The lock serialises this commit with rule and override edits from the API.
      const source = await selectSource(tx, this.tenantId, this.sourceId, true);
      if (protectionVersion(source.config) !== expectedVersion) {
        throw new DirectoryConflictError();
      }
      const userIds = await this.upsertUsers(tx, commit.plan);
      await this.writeObjects(tx, commit.plan.objects, userIds);
      await this.orphanObjects(tx, commit.plan.orphanExternalIds);
      const state = readDirectoryState(source.config);
      await tx
        .update(sources)
        .set({
          config: writeDirectoryState(source.config, {
            ...state,
            deltaLink: commit.deltaLink,
            sharedOrBlockedIds: commit.plan.sharedOrBlockedIds,
            lastFullSyncAt: commit.fullSyncAt ?? state.lastFullSyncAt,
          }),
        })
        .where(eq(sources.id, this.sourceId));
    });
  }

  /** Upsert the users of the plan (changed ones only); returns Entra object id -> users.id. */
  private async upsertUsers(tx: TenantTx, plan: DirectoryPlan): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    const existing = new Map<
      string,
      { id: string; email: string; upn: string | null; displayName: string | null }
    >();
    for (const batch of chunks(plan.users.map((user) => user.entraObjectId))) {
      const rows = await tx
        .select({
          id: users.id,
          entraObjectId: users.entraObjectId,
          email: users.email,
          upn: users.upn,
          displayName: users.displayName,
        })
        .from(users)
        .where(and(eq(users.tenantId, this.tenantId), inArray(users.entraObjectId, batch)));
      for (const row of rows) {
        if (row.entraObjectId) {
          existing.set(row.entraObjectId, row);
        }
      }
    }

    for (const user of plan.users) {
      const row = existing.get(user.entraObjectId);
      if (row) {
        ids.set(user.entraObjectId, row.id);
        const changed =
          row.email !== user.email || row.upn !== user.upn || row.displayName !== user.displayName;
        if (changed) {
          await this.updateUser(tx, row.id, user);
        }
        continue;
      }
      // A re-created account keeps its address: take that row over instead of
      // failing on the (tenant, email) unique index.
      const [inserted] = await tx
        .insert(users)
        .values({
          tenantId: this.tenantId,
          entraObjectId: user.entraObjectId,
          email: user.email,
          upn: user.upn,
          displayName: user.displayName,
          mailAddresses: [...(user.mailAddresses ?? [])],
        })
        .onConflictDoUpdate({
          target: [users.tenantId, users.email],
          set: {
            entraObjectId: user.entraObjectId,
            upn: user.upn,
            displayName: user.displayName,
            ...mailAddressesOf(user),
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: users.id });
      if (!inserted) {
        throw new Error(`directory user ${user.entraObjectId} could not be stored`);
      }
      ids.set(user.entraObjectId, inserted.id);
    }
    return ids;
  }

  /**
   * Update one user. When the new address already belongs to another
   * directory row, the old address is kept (inside a savepoint, so the run
   * goes on) and the conflict is logged for the operator.
   */
  private async updateUser(
    tx: TenantTx,
    id: string,
    user: DirectoryPlan["users"][number],
  ): Promise<void> {
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint
          .update(users)
          .set({
            email: user.email,
            upn: user.upn,
            displayName: user.displayName,
            ...mailAddressesOf(user),
          })
          .where(eq(users.id, id));
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      this.logger.warn("directory user address is taken by another entry; keeping the old one", {
        entraObjectId: user.entraObjectId,
      });
      await tx
        .update(users)
        .set({ upn: user.upn, displayName: user.displayName, ...mailAddressesOf(user) })
        .where(eq(users.id, id));
    }
  }

  /** Insert or update created/updated objects; re-scoped ones only change status. */
  private async writeObjects(
    tx: TenantTx,
    objects: readonly PlannedObject[],
    userIds: ReadonlyMap<string, string>,
  ): Promise<void> {
    const upserts = objects.filter((object) => object.change !== "rescoped");
    for (const batch of chunks(upserts)) {
      await tx
        .insert(protectedObjects)
        .values(
          batch.map((object) => ({
            tenantId: this.tenantId,
            sourceId: this.sourceId,
            userId: userIds.get(object.ownerId) ?? null,
            kind: object.kind,
            origin: "directory_sync" as const,
            status: object.status,
            externalId: object.externalId,
            displayName: object.displayName,
            activeSince: object.status === "active" ? sql`now()` : null,
          })),
        )
        .onConflictDoUpdate({
          target: [protectedObjects.sourceId, protectedObjects.externalId],
          set: {
            userId: sql`excluded.user_id`,
            kind: sql`excluded.kind`,
            origin: sql`excluded.origin`,
            status: sql`excluded.status`,
            displayName: sql`excluded.display_name`,
            // Only a transition into `active` moves the clock; staying
            // active (or excluded) across syncs must not push it out.
            activeSince: sql`case
              when excluded.status = 'active' and protected_objects.status is distinct from 'active'
                then now()
              else protected_objects.active_since
            end`,
            updatedAt: sql`now()`,
          },
        });
    }
    for (const status of ["active", "excluded"] as const) {
      const externalIds = objects
        .filter((object) => object.change === "rescoped" && object.status === status)
        .map((object) => object.externalId);
      for (const batch of chunks(externalIds)) {
        await tx
          .update(protectedObjects)
          .set({
            status,
            ...(status === "active"
              ? {
                  activeSince: sql`case
                    when protected_objects.status is distinct from 'active' then now()
                    else protected_objects.active_since
                  end`,
                }
              : {}),
          })
          .where(
            and(
              eq(protectedObjects.tenantId, this.tenantId),
              eq(protectedObjects.sourceId, this.sourceId),
              inArray(protectedObjects.externalId, batch),
            ),
          );
      }
    }
  }

  private async orphanObjects(tx: TenantTx, externalIds: readonly string[]): Promise<void> {
    for (const batch of chunks(externalIds)) {
      await tx
        .update(protectedObjects)
        .set({ status: "orphaned" })
        .where(
          and(
            eq(protectedObjects.tenantId, this.tenantId),
            eq(protectedObjects.sourceId, this.sourceId),
            eq(protectedObjects.origin, "directory_sync"),
            inArray(protectedObjects.externalId, batch),
          ),
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Source state
// ---------------------------------------------------------------------------

/** Record the run's outcome on the source: state for the UI, status for the health view. */
async function recordOutcome(
  run: TenantTxRunner,
  tenantId: string,
  sourceId: string,
  lastRun: DirectoryLastRun,
  logger: Logger,
): Promise<void> {
  try {
    await run(async (tx) => {
      const source = await selectSource(tx, tenantId, sourceId, true);
      const state = readDirectoryState(source.config);
      await tx
        .update(sources)
        .set({
          config: writeDirectoryState(source.config, { ...state, lastRun }),
          lastSyncAt: lastRun.ok ? new Date(lastRun.finishedAt) : source.lastSyncAt,
          // A paused source stays paused; otherwise the sync result is the health.
          status: source.status === "disabled" ? source.status : lastRun.ok ? "active" : "error",
          errorMessage: lastRun.ok ? null : lastRun.error,
          failure: lastRun.ok ? null : ((lastRun.failure as FailureRecordJson | null) ?? null),
        })
        .where(eq(sources.id, sourceId));
    });
  } catch (error) {
    logger.warn("could not record the directory sync outcome on the source", {
      errorMessage: safeErrorMessage(error),
    });
  }
}

/**
 * Failure text for the operator: the message, never a stack, never a token,
 * and for a failed query the driver's message rather than the query with its
 * bound parameters.
 */
function failureMessage(error: unknown): string {
  return safeErrorMessage(error).slice(0, 1000);
}

function successRun(result: DirectorySyncResult, finishedAt: Date): DirectoryLastRun {
  return {
    startedAt: result.startedAt,
    finishedAt: finishedAt.toISOString(),
    ok: true,
    mode: result.mode,
    counts: result.counts,
    ...capWarnings(result.warnings),
    error: null,
  };
}

function failedRun(
  startedAt: Date,
  finishedAt: Date,
  error: unknown,
  step: string | null = null,
): DirectoryLastRun {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ok: false,
    mode: null,
    counts: null,
    warnings: [],
    warningCount: 0,
    error: failureMessage(error),
    failure: jobFailureRecord({
      error,
      now: finishedAt,
      step,
      abortReason: null,
      retry: null,
      queue: "directory",
    }) as FailureRecord,
  };
}

// ---------------------------------------------------------------------------
// First backup of newly-protected objects
// ---------------------------------------------------------------------------

/** What {@link enqueueFirstBackupsAfterSync} reads and writes; injectable for tests. */
export interface FirstBackupStore {
  /**
   * Resolve newly-active objects (named by external id, the only thing a
   * plan carries) to their protected-object id and first-backup state: only
   * Postgres knows the id and the final, committed status. An external id
   * that is not `active` any more by the time this runs (rescoped again by a
   * concurrent change) is left out, same as one the RLS-scoped query never
   * finds.
   */
  loadCandidates(
    externalIds: readonly string[],
  ): Promise<readonly (FirstBackupCandidate & { readonly externalId: string })[]>;
  /**
   * Send the pg-boss job and record its `jobs` lifecycle row as one atomic
   * step; null when the backup singleton key is already queued or active
   * (pg-boss reports nothing sent, so there is nothing to record).
   */
  enqueueBackup(payload: BackupJobPayload): Promise<string | null>;
  /** One audit entry naming every object actually queued, attributed to the system. */
  auditQueued(protectedObjectIds: readonly string[]): Promise<void>;
}

/**
 * Enqueue the first backup of every object this sync just made `active` for
 * the first time ({@link DirectorySyncResult.newlyActive}): new objects and
 * ones re-included after being excluded or orphaned. Uses the same selection
 * as an admin include or an IMAP account being added
 * (@restow/core's `selectFirstBackupTargets`, unit tested there), so a
 * mailbox or OneDrive the directory just started protecting does not sit
 * idle until the tenant's backup schedule next runs. Idempotent through the
 * backup queue's singleton key (one queued/active job per object), the same
 * guarantee every other caller of this selection relies on.
 *
 * `store` is expected to run every method against the same open transaction
 * (see {@link pgFirstBackupStore}), so the pg-boss send, the `jobs` row and
 * the audit entry of every object queued here commit or roll back together —
 * never a job the audit log does not know about. `signal` is checked between
 * objects so a cancelled or shutting-down job stops sending more of them
 * instead of racing the process exit; whatever was already queued in this
 * transaction is still committed and audited.
 */
export async function enqueueFirstBackupsAfterSync(options: {
  readonly tenantId: string;
  readonly newlyActive: readonly NewlyActiveObject[];
  readonly store: FirstBackupStore;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly jobIdGenerator?: () => string;
}): Promise<string[]> {
  const { tenantId, newlyActive, store, signal, logger } = options;
  if (newlyActive.length === 0) {
    return [];
  }
  const candidates = await store.loadCandidates(newlyActive.map((object) => object.externalId));
  const targets = selectFirstBackupTargets(candidates);
  const queued: string[] = [];
  for (const protectedObjectId of targets) {
    if (signal.aborted) {
      break;
    }
    const payload: BackupJobPayload = {
      jobId: (options.jobIdGenerator ?? randomUUID)(),
      tenantId,
      protectedObjectId,
    };
    const pgBossJobId = await store.enqueueBackup(payload);
    if (pgBossJobId === null) {
      continue;
    }
    queued.push(protectedObjectId);
  }
  if (queued.length > 0) {
    await store.auditQueued(queued);
  }
  logger.info("first backup enqueue after directory sync", {
    candidates: newlyActive.length,
    queued: queued.length,
    aborted: signal.aborted,
  });
  return queued;
}

/**
 * Must match apps/api/src/features/jobs/service.ts's
 * `JOB_AUDIT_ACTIONS.firstBackupQueued`: apps/worker cannot import apps/api,
 * so the two sides of this one shared action name are kept in sync by hand.
 */
const FIRST_BACKUP_AUDIT_ACTION = "backup.first_queued";
/** Audit detail keeps at most this many ids; entries beyond that get one more entry each. */
const MAX_AUDITED_FIRST_BACKUP_IDS = 200;

/**
 * Postgres-backed {@link FirstBackupStore}, scoped to one source's tenant and
 * bound to a single open transaction: every read and write below runs
 * against `tx`, so a caller that wraps one call to
 * {@link enqueueFirstBackupsAfterSync} in one `run(...)` gets one atomic
 * commit for the whole batch (see `runDirectoryJob`).
 */
export function pgFirstBackupStore(
  tx: TenantTx,
  tenantId: string,
  sourceId: string,
  boss: PgBoss,
): FirstBackupStore {
  return {
    async loadCandidates(externalIds) {
      if (externalIds.length === 0) {
        return [];
      }
      const activeRows: { id: string; externalId: string }[] = [];
      for (const batch of chunks(externalIds)) {
        activeRows.push(
          ...(await tx
            .select({ id: protectedObjects.id, externalId: protectedObjects.externalId })
            .from(protectedObjects)
            .where(
              and(
                eq(protectedObjects.tenantId, tenantId),
                eq(protectedObjects.sourceId, sourceId),
                eq(protectedObjects.status, "active"),
                inArray(protectedObjects.externalId, batch),
              ),
            )),
        );
      }
      const ids = activeRows.map((row) => row.id);
      if (ids.length === 0) {
        return [];
      }
      const withSnapshot = new Set<string>();
      const withJob = new Set<string>();
      for (const batch of chunks(ids)) {
        const snapshotRows = await tx
          .selectDistinct({ protectedObjectId: snapshots.protectedObjectId })
          .from(snapshots)
          .where(
            and(
              eq(snapshots.tenantId, tenantId),
              eq(snapshots.status, "active"),
              isNotNull(snapshots.manifestPath),
              inArray(snapshots.protectedObjectId, batch),
            ),
          );
        for (const row of snapshotRows) {
          withSnapshot.add(row.protectedObjectId);
        }
        const jobRows = await tx
          .selectDistinct({ protectedObjectId: jobs.protectedObjectId })
          .from(jobs)
          .where(
            and(
              eq(jobs.tenantId, tenantId),
              eq(jobs.queue, "backup"),
              inArray(jobs.status, ["queued", "active"]),
              inArray(jobs.protectedObjectId, batch),
            ),
          );
        for (const row of jobRows) {
          if (row.protectedObjectId) {
            withJob.add(row.protectedObjectId);
          }
        }
      }
      return activeRows.map((row) => ({
        protectedObjectId: row.id,
        externalId: row.externalId,
        hasSnapshot: withSnapshot.has(row.id),
        hasQueuedOrActiveBackup: withJob.has(row.id),
      }));
    },

    async enqueueBackup(payload) {
      const pgBossJobId = await boss.send("backup", payload, {
        ...sendOptionsFor("backup", payload),
        db: pgBossExecutor(tx),
      });
      if (pgBossJobId === null) {
        return null;
      }
      await tx
        .insert(jobs)
        .values({
          id: payload.jobId,
          tenantId,
          queue: "backup",
          status: "queued",
          protectedObjectId: payload.protectedObjectId,
          payload: payload as unknown as Record<string, unknown>,
          pgBossJobId,
        })
        .onConflictDoNothing({ target: jobs.id });
      return pgBossJobId;
    },

    async auditQueued(protectedObjectIds) {
      // One entry per chunk of MAX_AUDITED_FIRST_BACKUP_IDS, so a large batch
      // (a tenant's whole directory onboarding) still names every object
      // queued somewhere in the audit log, not only the first 200 of them.
      for (const batch of chunks(protectedObjectIds, MAX_AUDITED_FIRST_BACKUP_IDS)) {
        await appendAuditEntry(tx, {
          tenantId,
          actor: "system",
          action: FIRST_BACKUP_AUDIT_ACTION,
          target: tenantId,
          targetType: "tenant",
          details: {
            count: batch.length,
            protectedObjectIds: batch,
            truncated: false,
          },
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/** Run one directory job with injectable dependencies (tests pass a fake Graph). */
export async function runDirectoryJob(
  ctx: WorkerJobContext,
  payload: DirectoryJobPayload,
  deps: DirectoryHandlerDeps,
) {
  const run = tenantRunner(ctx.db, ctx.tenantId);
  const [source] = await run((tx) =>
    tx
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, ctx.tenantId), eq(sources.id, payload.sourceId)))
      .limit(1),
  );
  if (!source) {
    throw new InvalidPayloadError(`source ${payload.sourceId} does not exist`);
  }
  const logger = ctx.logger.child({ sourceId: source.id, sourceKind: source.kind });
  if (source.kind !== "m365") {
    logger.info("directory sync skipped: IMAP accounts are maintained by hand");
    return { summary: { skipped: "imap_source" } };
  }
  if (source.status === "disabled") {
    logger.info("directory sync skipped: the source is disabled");
    return { summary: { skipped: "source_disabled" } };
  }
  if (!source.entraTenantId) {
    logger.info("directory sync skipped: admin consent is outstanding");
    return { summary: { skipped: "consent_outstanding" } };
  }

  const startedAt = ctx.now();
  const reason = fullSyncReason(
    readDirectoryState(source.config),
    startedAt,
    deps.fullSyncIntervalMs ?? FULL_SYNC_INTERVAL_MS,
  );
  // Phases and Graph throttling waits go to `jobs.payload.runtime`, so the
  // directory view says "paused by Microsoft" instead of looking stuck.
  const recorder = new PhaseRecorder(
    ctx.progress,
    (state) => mergeJobPayload(run, ctx.tenantId, ctx.jobId, { [RUNTIME_KEY]: state }),
    logger,
    ctx.now,
  );
  try {
    const client = await deps.graphClientFor(source, ctx, (info) => recorder.throttled(info));
    const result = await syncDirectory({
      client,
      repository: new PgDirectoryRepository(run, ctx.tenantId, source.id, logger),
      full: reason !== null,
      logger,
      progress: recorder,
      signal: ctx.signal,
      now: ctx.now,
    });
    await recordOutcome(run, ctx.tenantId, source.id, successRun(result, ctx.now()), logger);
    let firstBackupsQueued = 0;
    if (result.newlyActive.length > 0) {
      // Best effort: the sync itself already committed and must not fail (or
      // retry) over this. A miss here is caught up by the tenant's backup
      // schedule or an admin's "Backup now": the object is already `active`
      // in `known` by the time this runs, so a later sync will not see it as
      // newly active again and cannot retry the enqueue itself. The send,
      // the `jobs` row and the audit entry of every object queued below
      // commit together in one transaction (pgFirstBackupStore), so this
      // never leaves an unaudited job even if it fails partway.
      try {
        const queued = await run((tx) =>
          enqueueFirstBackupsAfterSync({
            tenantId: ctx.tenantId,
            newlyActive: result.newlyActive,
            store: pgFirstBackupStore(tx, ctx.tenantId, source.id, bossFor(ctx.db)),
            signal: ctx.signal,
            logger,
          }),
        );
        firstBackupsQueued = queued.length;
      } catch (error) {
        logger.warn("could not enqueue first backups after the directory sync", {
          errorMessage: safeErrorMessage(error),
        });
      }
    }
    const throttle = recorder.throttleTotals();
    return {
      summary: {
        mode: result.mode,
        fullReason: reason ?? undefined,
        pages: result.pages,
        warnings: result.warnings.length,
        ...result.counts,
        firstBackupsQueued,
        throttleWaits: throttle.waits,
        throttleWaitMs: throttle.totalWaitMs,
      },
    };
  } catch (error) {
    // An interrupted run is not a failed source: the retry continues it.
    if (!(error instanceof JobAbortedError)) {
      await recordOutcome(
        run,
        ctx.tenantId,
        source.id,
        failedRun(startedAt, ctx.now(), error, ctx.progress.snapshot().phase),
        logger,
      );
    }
    throw error;
  } finally {
    // Whatever happened, the phase and any throttle wait must not outlive the run.
    await recorder.finish();
  }
}

const fullSyncIntervalMs = fullSyncIntervalFrom(process.env);

export const directoryHandler: JobHandler<"directory"> = {
  queue: "directory",
  // The singleton key already keeps one run per source; this keeps many
  // tenants from racing the token endpoint at the top of the hour.
  concurrency: 2,
  run: (ctx, payload) =>
    runDirectoryJob(ctx, payload, {
      graphClientFor: (source, jobCtx, throttled) =>
        graphClientForSource(source, jobCtx, throttled),
      fullSyncIntervalMs,
    }),
};

/**
 * The mailbox addresses to store for a user: only when the entry carried them
 * (an incremental entry without `proxyAddresses` keeps what an earlier run stored).
 */
function mailAddressesOf(user: { readonly mailAddresses: readonly string[] | null }): {
  mailAddresses?: string[];
} {
  return user.mailAddresses === null ? {} : { mailAddresses: [...user.mailAddresses] };
}
