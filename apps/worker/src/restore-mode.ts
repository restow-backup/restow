/**
 * Restore mode in the worker (docs/STORAGE.md, "Restore mode and progress markers").
 *
 * After a database dump is restored the database knows less than the storage. The worker
 *
 *   - installs the deletion guard (@restow/core storage/deletion-guard.ts) backed by the
 *     database's restore mode and the comparison of every tenant's storage with it; a target
 *     ahead of the database switches restore mode on by itself, raises the alert and writes the
 *     audit entry ({@link WorkerRestoreModeStore});
 *   - writes progress markers next to the data it stores ({@link withTenantProgressMarkers});
 *   - compares every tenant at its start, before it consumes a queue ({@link checkAtStart});
 *   - holds every job created before restore mode began instead of running or resuming it
 *     ({@link RestoreModeJobHold}, used by the job gate, by the job runner for a job that waits
 *     or runs when restore mode comes on, and by the reconcile pass).
 *
 * Everything runs on the installation pool.
 */
import {
  buildCause,
  type ChannelColumns,
  type GuardTarget,
  type Logger,
  pruneProgressMarkers,
  type RestoreModeDetectionInput,
  RestoreModeGuard,
  type RestoreModeSnapshot,
  type RestoreModeStore,
  type StorageBackend,
  type StorageTargets,
  subjectKeyOf,
  type TargetProgress,
  toFailureRecord,
  withDeletionPermit,
  withProgressMarkers,
} from "@restow/core";
import {
  activateRestoreMode,
  allocateStorageProgress,
  type Database,
  detectedHoldBoundary,
  drizzleQueryable,
  type FailureRecordJson,
  type NewNotification,
  type NewReportDelivery,
  notifications,
  planRuleDeliveries,
  readInstallationIdentity,
  readRestoreMode,
  readStorageProgress,
  rebaseStorageProgress,
  recordKeyMirrorFinding,
  recordRestoreModeRefusal,
  recordStorageProgressCheck,
  reportDeliveries,
  reportEvents,
  reportRules,
  resolveKeyMirrorFindings,
  safeErrorMessage,
  tenantDigestZone,
  tenants,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { appendAuditEntry } from "./audit.js";
import type { ResolvedTenantStorage } from "./handlers/framework.js";
import type { TenantTx } from "./progress.js";
import { channelColumns, reportInstallationTimeZone } from "./reporting.js";

export const RESTORE_MODE_EVENT = "installation.restore_mode";
export const KEY_MIRROR_CONFLICT_EVENT = "installation.key_mirror_conflict";

/** Why a held job ended, as its row explains it. */
export const RESTORE_MODE_HOLD_MESSAGE =
  "The job is from before the database restore; start it again if it is still needed.";

// ---------------------------------------------------------------------------
// Installation events (the worker's copy of apps/api features/updates/notify.ts)
// ---------------------------------------------------------------------------

export interface WorkerInstallationEvent {
  readonly event: typeof RESTORE_MODE_EVENT | typeof KEY_MIRROR_CONFLICT_EVENT;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly details: Record<string, unknown>;
  readonly now: Date;
}

/**
 * One notification without a tenant (the bell of provider administrators), a `report_events` row
 * the API's dispatcher fans out to the provider's recipients (apps/api features/reports/fanout.ts)
 * and the deliveries of every tenant's enabled event rule that lists the event, each only to the
 * channels whose column in the notification matrix has it on (at once, or held for a recipient's
 * digest), inside the caller's transaction.
 */
export async function raiseWorkerInstallationEvent(
  tx: TenantTx,
  input: WorkerInstallationEvent,
): Promise<void> {
  const { event, level, message, details, now } = input;
  const notification: NewNotification = {
    tenantId: null,
    level,
    event,
    message,
    details,
    createdAt: now,
  };
  await tx.insert(notifications).values(notification);
  const [reportEvent] = await tx
    .insert(reportEvents)
    .values({
      tenantId: null,
      event,
      level,
      subjectKey: subjectKeyOf(event, details),
      message,
      details,
      occurredAt: now,
      createdAt: now,
    })
    .returning({ id: reportEvents.id });
  const rules = await tx
    .select({ rule: reportRules })
    .from(reportRules)
    .innerJoin(tenants, eq(tenants.id, reportRules.tenantId))
    .where(
      and(
        eq(reportRules.enabled, true),
        eq(reportRules.trigger, "event"),
        eq(tenants.status, "active"),
        sql`${event} = ANY(${reportRules.events})`,
      ),
    );
  const rows: NewReportDelivery[] = [];
  const contexts = new Map<string, { columns: ChannelColumns; timeZone: string }>();
  for (const { rule } of rules) {
    let context = contexts.get(rule.tenantId);
    if (!context) {
      context = {
        columns: await channelColumns(tx, rule.tenantId),
        timeZone: await tenantDigestZone(tx, rule.tenantId, reportInstallationTimeZone),
      };
      contexts.set(rule.tenantId, context);
    }
    rows.push(
      ...(await planRuleDeliveries(tx, rule.tenantId, rule, notification, now, {
        ...context,
        reportEventId: reportEvent?.id ?? null,
      })),
    );
  }
  if (rows.length > 0) {
    await tx.insert(reportDeliveries).values(rows);
  }
}

// ---------------------------------------------------------------------------
// The guard's database side
// ---------------------------------------------------------------------------

export class WorkerRestoreModeStore implements RestoreModeStore {
  private installation: Promise<string | null> | null = null;

  constructor(
    private readonly providerDb: Database,
    /** When this process started: a detection never holds jobs created after it. */
    private readonly processStartedAt: Date | null = null,
  ) {}

  async read(): Promise<RestoreModeSnapshot> {
    const state = await readRestoreMode(this.providerDb.$client);
    return {
      active: state.active,
      id: state.id,
      activatedAt: state.activatedAt,
      holdJobsBefore: state.holdJobsBefore,
      keepUnknownBefore: state.keepUnknownBefore,
    };
  }

  readDbSeq(tenantId: string): Promise<number> {
    return readStorageProgress(this.providerDb.$client, tenantId);
  }

  async readDbKeyMax(tenantId: string): Promise<number> {
    const { rows } = await this.providerDb.$client.query<{ version: number | null }>(
      "SELECT max(key_version) AS version FROM tenant_keys WHERE tenant_id = $1::uuid",
      [tenantId],
    );
    return Number(rows[0]?.version ?? 0);
  }

  installationId(): Promise<string | null> {
    this.installation ??= readInstallationIdentity(this.providerDb.$client).catch((error) => {
      this.installation = null;
      throw error;
    });
    return this.installation;
  }

  async recordCheck(tenantId: string, result: TargetProgress): Promise<void> {
    await recordStorageProgressCheck(this.providerDb.$client, {
      tenantId,
      targetId: result.targetId,
      outcome: result.outcome,
      storageMaxSeq: result.storageMaxSeq,
      dbSeq: result.dbSeq,
      unknownKeyVersions: result.unknownKeyVersions,
      detail: result.detail,
    });
  }

  async activateDetected(
    detection: RestoreModeDetectionInput,
  ): Promise<{ id: string; created: boolean }> {
    const now = new Date();
    return this.providerDb.transaction(async (tx) => {
      const queryable = drizzleQueryable(tx);
      // Hold the jobs of the restored dump only: new backups the scheduler queued since the
      // processes started keep running.
      const holdJobsBefore = await detectedHoldBoundary(queryable, this.processStartedAt);
      const activated = await activateRestoreMode(queryable, {
        source: "detected",
        reason: "A storage target shows progress the database does not have.",
        actor: { label: "system:worker" },
        detection: { ...detection, keyVersions: [...detection.keyVersions] },
        now,
        holdJobsBefore,
      });
      if (activated.created) {
        const details = {
          tenantId: detection.tenantId,
          targetId: detection.targetId,
          markerSeq: detection.markerSeq,
          dbSeq: detection.dbSeq,
          keyVersions: [...detection.keyVersions],
          restoreModeId: activated.id,
          objectName: "restore mode",
        };
        await appendAuditEntry(tx, {
          tenantId: null,
          actor: "system",
          action: "installation.restore_mode.detected",
          target: activated.id,
          targetType: "installation",
          details,
        });
        await raiseWorkerInstallationEvent(tx, {
          event: RESTORE_MODE_EVENT,
          level: "error",
          message:
            "Restore mode is on: a storage target shows progress the database does not have. Nothing is deleted until a provider owner ends it.",
          details,
          now,
        });
      }
      return activated;
    });
  }

  async rebaseAbove(tenantId: string, to: number): Promise<void> {
    await rebaseStorageProgress(this.providerDb.$client, tenantId, to);
  }

  async recordRefusal(input: {
    restoreModeId: string;
    tenantId: string | null;
    pass: string;
    sample?: Record<string, unknown>;
  }): Promise<void> {
    await recordRestoreModeRefusal(this.providerDb.$client, input);
  }
}

/** The targets the guard compares: primary and copies (a retired `previous` one is read-only). */
export function guardTargetsOf(storage: StorageTargets): GuardTarget[] {
  const resolved = storage as Partial<ResolvedTenantStorage>;
  if (resolved.targets) {
    return resolved.targets
      .filter((target) => target.role !== "previous")
      .map((target) => ({ id: target.id, backend: target.backend }));
  }
  return [
    { id: "primary", backend: storage.primary },
    ...storage.copies.map((backend, index) => ({ id: `copy:${index}`, backend })),
  ];
}

export function createWorkerRestoreModeGuard(options: {
  readonly providerDb: Database;
  readonly storageOf: (tenantId: string) => Promise<StorageTargets>;
  readonly logger: Logger;
  /** When the worker process started (index.ts). */
  readonly processStartedAt?: Date;
}): { guard: RestoreModeGuard; store: WorkerRestoreModeStore } {
  const store = new WorkerRestoreModeStore(options.providerDb, options.processStartedAt ?? null);
  const guard = new RestoreModeGuard({
    store,
    targetsOf: async (tenantId) => guardTargetsOf(await options.storageOf(tenantId)),
    logger: options.logger,
  });
  return { guard, store };
}

// ---------------------------------------------------------------------------
// Progress markers on the tenant's targets
// ---------------------------------------------------------------------------

/**
 * The tenant's resolved storage with a progress marker written before the data on every primary
 * and copy target (a retired `previous` target is only read). The same backend object keeps its
 * identity across `primary`, `copies` and `targets`.
 */
export function withTenantProgressMarkers<T extends StorageTargets>(
  storage: T,
  options: {
    readonly tenantId: string;
    readonly providerDb: Database;
    readonly installationId: () => Promise<string | null>;
    readonly version?: string | null;
    readonly intervalMs?: number;
    /**
     * A marker value taken already: `ours` (this installation's marker) proves the storage is
     * ahead; the guard switches restore mode on and compares that target.
     */
    readonly onCollision?: (
      tenantId: string,
      target: GuardTarget,
      seq: number,
      ours: boolean,
    ) => Promise<void>;
    /**
     * Before the first value is allocated for the tenant in this process: compare these
     * targets with the database (the guard's `compareBeforeFirstAllocation`).
     */
    readonly beforeFirstAllocation?: (
      tenantId: string,
      targets: readonly GuardTarget[],
    ) => Promise<void>;
  },
): T {
  const resolvedTargets = storage as unknown as Partial<ResolvedTenantStorage>;
  const compareTargets: GuardTarget[] = guardTargetsOf(storage);
  const wrapped = new Map<StorageBackend, StorageBackend>();
  const wrap = (backend: StorageBackend, targetId: string): StorageBackend => {
    let result = wrapped.get(backend);
    if (!result) {
      result = withProgressMarkers(backend, {
        tenantId: options.tenantId,
        targetId,
        allocate: (tenantId) => allocateStorageProgress(options.providerDb.$client, tenantId),
        installationId: options.installationId,
        writer: "worker",
        version: options.version ?? null,
        ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
        ...(options.onCollision
          ? {
              onCollision: (tenantId: string, seq: number, collision: { ours: boolean }) =>
                options.onCollision?.(tenantId, { id: targetId, backend }, seq, collision.ours) ??
                Promise.resolve(),
            }
          : {}),
        ...(options.beforeFirstAllocation
          ? {
              beforeFirstAllocation: (tenantId: string) =>
                options.beforeFirstAllocation?.(tenantId, compareTargets) ?? Promise.resolve(),
            }
          : {}),
      });
      wrapped.set(backend, result);
    }
    return result;
  };
  const resolved = resolvedTargets;
  const ids = new Map<StorageBackend, string>();
  for (const target of resolved.targets ?? []) {
    if (target.role !== "previous") {
      ids.set(target.backend, target.id);
    }
  }
  const primary = wrap(storage.primary, ids.get(storage.primary) ?? "primary");
  const copies = storage.copies.map((backend, index) =>
    wrap(backend, ids.get(backend) ?? `copy:${index}`),
  );
  const next = { ...storage, primary, copies } as T;
  if (resolved.targets) {
    (next as unknown as { targets: ResolvedTenantStorage["targets"] }).targets =
      resolved.targets.map((target) =>
        target.role === "previous"
          ? target
          : { ...target, backend: wrap(target.backend, target.id) },
      );
  }
  return next;
}

// ---------------------------------------------------------------------------
// The process's restore mode runtime (set at start; tests set their own)
// ---------------------------------------------------------------------------

let runtimeProviderDb: Database | null = null;

/** Configure the installation pool the handlers use for progress values (index.ts, tests). */
export function configureRestoreModeRuntime(options: {
  readonly providerDb: Database | null;
}): void {
  runtimeProviderDb = options.providerDb;
}

/**
 * Delete old progress markers on the tenant's mutable targets (scrub, full mode): the folders
 * before the one before the database's current value. Never on a write-once target.
 */
export async function pruneTenantProgressMarkers(ctx: {
  readonly tenantId: string;
  readonly storage: StorageTargets;
}): Promise<number> {
  if (!runtimeProviderDb) {
    return 0;
  }
  const seq = await readStorageProgress(runtimeProviderDb.$client, ctx.tenantId);
  const resolved = ctx.storage as Partial<ResolvedTenantStorage>;
  const targets = resolved.targets
    ? resolved.targets.filter((target) => target.role !== "previous" && !target.writeOnce)
    : [{ backend: ctx.storage.primary }, ...ctx.storage.copies.map((backend) => ({ backend }))];
  return withDeletionPermit({ pass: "progress_marker_prune", tenantId: ctx.tenantId }, async () => {
    let removed = 0;
    for (const target of targets) {
      removed += await pruneProgressMarkers(target.backend, ctx.tenantId, seq);
    }
    return removed;
  });
}

// ---------------------------------------------------------------------------
// The check at the worker's start
// ---------------------------------------------------------------------------

/**
 * Compare every tenant's storage with the database before the worker takes any job: 8 tenants at
 * a time, at most `capMs` (whatever is left continues in the background).
 */
export async function checkAtStart(
  guard: RestoreModeGuard,
  providerDb: Database,
  logger: Logger,
  options: { readonly capMs?: number; readonly concurrency?: number } = {},
): Promise<void> {
  try {
    const { rows } = await providerDb.$client.query<{ id: string }>(
      "SELECT id::text AS id FROM tenants ORDER BY created_at",
    );
    const started = Date.now();
    const checks = await guard.checkTenants(
      rows.map((row) => row.id),
      { concurrency: options.concurrency ?? 8, capMs: options.capMs ?? 120_000 },
    );
    const ahead = checks.filter((check) => check.outcome === "ahead");
    logger.info("storage progress compared with the database", {
      tenants: rows.length,
      checked: checks.length,
      ahead: ahead.length,
      unreachable: checks.filter((check) => check.outcome === "unreachable").length,
      ms: Date.now() - started,
    });
  } catch (error) {
    logger.warn("could not compare the storage with the database at start", {
      errorMessage: safeErrorMessage(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Holding jobs from before the restore
// ---------------------------------------------------------------------------

/** The failure a held job's row records. */
export function restoreModeHoldFailure(queue: string, now: Date): FailureRecordJson {
  return toFailureRecord(buildCause("job.restore_mode_hold", { queue }), {
    now,
    step: null,
    retry: null,
  }) as FailureRecordJson;
}

/** A pg-boss job as the work handler gets it (`includeMetadata` adds `createdOn`). */
interface DeliveredJob {
  readonly id: string;
  readonly name?: string;
  readonly createdOn?: Date | string;
}

/**
 * Jobs created before restore mode began are held: their `jobs` row is cancelled with the
 * explanation, their pg-boss job is cancelled, and they never run (a backup from the dump could
 * otherwise resume a checkpoint the restored index does not know). A job that already runs when
 * restore mode comes on is stopped by the runner (framework.ts `runJob`, abort reason
 * `restore_mode_hold`) and ends here as well, without a retry. New jobs run as usual.
 */
export class RestoreModeJobHold {
  constructor(
    private readonly providerDb: Database,
    private readonly state: () => Promise<RestoreModeSnapshot>,
    private readonly logger: Logger,
  ) {}

  /** Whether `createdOn` lies before the active restore mode's hold point. */
  async holds(createdOn: Date | null): Promise<RestoreModeSnapshot | null> {
    const state = await this.state();
    if (!state.active || !state.holdJobsBefore) {
      return null;
    }
    if (createdOn !== null && createdOn.getTime() >= state.holdJobsBefore.getTime()) {
      return null;
    }
    return state;
  }

  /**
   * Hold `job` of `queue` when restore mode says so: true when it was held (the caller must not
   * run it), false otherwise.
   */
  async holdIfBeforeRestore(queue: string, job: DeliveredJob): Promise<boolean> {
    let createdOn = job.createdOn ? new Date(job.createdOn) : null;
    const state = await this.state();
    if (!state.active) {
      return false;
    }
    if (createdOn === null) {
      const { rows } = await this.providerDb.$client.query<{ created_on: Date }>(
        "SELECT created_on FROM pgboss.job WHERE id = $1::uuid LIMIT 1",
        [job.id],
      );
      createdOn = rows[0]?.created_on ? new Date(rows[0].created_on) : null;
    }
    if (!(await this.holds(createdOn))) {
      return false;
    }
    await this.cancel(queue, job.id);
    return true;
  }

  /**
   * Cancel the pg-boss job `bossJobId` and its row (the reconcile pass, the gate and the runner);
   * the row keeps no checkpoint: nothing resumes it.
   */
  async cancel(queue: string, bossJobId: string): Promise<void> {
    const now = new Date();
    const failure = restoreModeHoldFailure(queue, now);
    await this.providerDb.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE pgboss.job SET state = 'cancelled', completed_on = now()
         WHERE id = ${bossJobId}::uuid AND state < 'completed'`);
      await tx.execute(sql`
        UPDATE jobs
           SET status = 'cancelled',
               failure = ${JSON.stringify(failure)}::jsonb,
               error_message = ${RESTORE_MODE_HOLD_MESSAGE},
               cursor = NULL,
               completed_at = ${now.toISOString()}::timestamptz,
               updated_at = now()
         WHERE pg_boss_job_id = ${bossJobId}
           AND status NOT IN ('completed', 'failed', 'cancelled')`);
    });
    this.logger.warn("job held: it is from before the database restore", {
      queue,
      pgBossJobId: bossJobId,
    });
  }
}

// ---------------------------------------------------------------------------
// Wrapped keys in storage that differ from the database
// ---------------------------------------------------------------------------

export interface KeyMirrorFindingInput {
  readonly tenantId: string;
  readonly targetId: string;
  /** 0 for a sealed repository password document. */
  readonly keyVersion: number;
  /** A sealed repository password document: its storage key. */
  readonly objectKey?: string | null;
  readonly storedSha256: string;
  readonly kind: "conflict" | "damaged";
}

/** Record a finding; a new one raises the alert and writes the tenant's audit entry. */
export async function reportKeyMirrorFinding(
  providerDb: Database,
  finding: KeyMirrorFindingInput,
  logger: Logger,
): Promise<void> {
  const now = new Date();
  try {
    await providerDb.transaction(async (tx) => {
      const fresh = await recordKeyMirrorFinding(drizzleQueryable(tx), { ...finding, now });
      if (!fresh) {
        return;
      }
      const objectName = finding.objectKey ?? `keys/${finding.keyVersion}`;
      const details = { ...finding, objectName };
      await appendAuditEntry(tx, {
        tenantId: finding.tenantId,
        actor: "system",
        action: "tenant.key_mirror.conflict",
        target: objectName,
        targetType: "storage_target",
        details,
      });
      await raiseWorkerInstallationEvent(tx, {
        event: KEY_MIRROR_CONFLICT_EVENT,
        level: "error",
        message: finding.objectKey
          ? `A sealed repository password in storage (${finding.objectKey}) differs from the database's; it was not overwritten.`
          : `A wrapped tenant key in storage (version ${finding.keyVersion}) differs from the database's; it was not overwritten.`,
        details,
        now,
      });
    });
  } catch (error) {
    logger.warn("could not record a wrapped key that differs from the database", {
      ...finding,
      errorMessage: safeErrorMessage(error),
    });
  }
}

/**
 * Resolve the open findings of a key version on a target (the mirror saw the database's key there
 * again, or other bytes than the open finding names).
 */
export async function resolveKeyMirrorFinding(
  providerDb: Database,
  input: {
    readonly tenantId: string;
    readonly targetId: string;
    readonly keyVersion: number;
    readonly keepSha256: string | null;
  },
  logger: Logger,
): Promise<void> {
  const resolved = await resolveKeyMirrorFindings(providerDb.$client, input);
  if (resolved > 0) {
    logger.info("a wrapped key finding is resolved: the target holds other bytes now", {
      ...input,
      resolved,
    });
  }
}

/**
 * Report a sealed repository password document in storage that differs from the database's (it is
 * never replaced, @restow/core endpoints/repository-key.ts): a finding with key version 0 and the
 * document's key, its alert and audit entry, like a wrapped key that differs.
 */
export async function reportRepositoryPasswordFinding(
  providerDb: Database,
  input: {
    readonly tenantId: string;
    readonly targetId: string;
    readonly objectKey: string;
    readonly storedSha256: string;
    readonly kind: "conflict" | "damaged";
  },
  logger: Logger,
): Promise<void> {
  logger.error(
    "a sealed repository password in storage differs from the database; it is not overwritten",
    { ...input },
  );
  await reportKeyMirrorFinding(providerDb, { ...input, keyVersion: 0 }, logger);
}

/** The id of the tenant's target `backend` is (primary and copies), "primary" when unknown. */
export async function targetIdOfBackend(
  storageOf: (tenantId: string) => Promise<StorageTargets>,
  tenantId: string,
  backend: StorageBackend,
): Promise<string> {
  const storage = (await storageOf(tenantId).catch(
    () => null,
  )) as Partial<ResolvedTenantStorage> | null;
  return storage?.targets?.find((target) => target.backend === backend)?.id ?? "primary";
}
