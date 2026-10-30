/**
 * The `backup` queue handler.
 *
 * One job backs up one protected object into one snapshot. The handler is the
 * orchestration around a {@link BackupEngine}:
 *
 *   1. load the object's source and refuse what an operator has to fix first
 *      (excluded or orphaned object, source not connected or disabled, a kind
 *      that does not belong to the source),
 *   2. build the engine for the object's kind with what it needs from the
 *      source: a throttled Graph client for the customer tenant (mailbox,
 *      OneDrive) or the IMAP account (server, login, stored credential),
 *   3. run it with the framework's progress, cursor and failure persistence;
 *      the engine creates the snapshot row and commits the manifest, which is
 *      what turns the snapshot from "running" into "completed",
 *   4. insist on a committed manifest, make sure every copy target holds it,
 *   5. hand the object to the verify queue when the tenant scheduled restore
 *      checks (docs/TESTING.md: a backup without a verified restore is not
 *      done), and store the outcome on the job for the UI.
 *
 * Honesty over silence: the engine's phase ("enumerate", "download", ...) and
 * every wait forced by Graph throttling are persisted under
 * `jobs.payload.runtime`, so the UI can say "waiting for Microsoft 365, 32 s"
 * instead of looking stuck. `job_progress` carries the counters only.
 *
 * The backup app registration (the same the directory handler uses) is
 * resolved when a Graph client is built (../entra-app.ts): ENTRA_CLIENT_ID plus
 * ENTRA_CLIENT_SECRET or ENTRA_CLIENT_CERT_PATH (and ENTRA_AUTHORITY_HOST) from
 * the environment when set, otherwise the registration saved under Settings →
 * Microsoft 365. A source may carry its own client secret in `secret_ref`,
 * which takes precedence over the app's credential.
 *
 * Environment:
 *   IMAP_ALLOW_INSECURE      "true" permits IMAP sources without TLS (development only)
 *   IMAP_ALLOW_PRIVATE_NETWORKS
 *                            "true" lets every IMAP source reach loopback and private
 *                            networks; otherwise only hosts a provider admin approved may
 */
import { randomUUID } from "node:crypto";
import {
  type ActivityReport,
  type AppCredentials,
  appCredentialsFingerprint,
  type BackupEngine,
  type BackupJobPayload,
  type BackupResult,
  buildCause,
  type ChunkDataStats,
  ClientCredentialsTokenProvider,
  classifyFailure,
  confirmMailboxInactive,
  confirmObjectLocked,
  ExchangeBackupEngine,
  encryptChunk,
  entraAppCredentialsOf,
  type FailureCause,
  type FailureCode,
  FetchGraphClient,
  type FirstBackupProgress,
  type GraphClient,
  GroupMailboxBackupEngine,
  type ImapAccountConfig,
  ImapBackupEngine,
  type ItemFailureDetails,
  type ItemFailureRecord,
  isLoginRefusalCause,
  JOB_PRIORITY,
  LOGIN_PROBE_INTERVAL_HOURS,
  type Logger,
  type ObjectStatusReason,
  OneDriveBackupEngine,
  type ProgressReporter,
  type ProgressSnapshot,
  type ProtectedObjectKind,
  type ProtectedObjectRef,
  parseSourceAppSecret,
  SharePointBackupEngine,
  type StorageTargets,
  singletonKeyFor,
  type TenantKeyring,
  type ThrottleInfo,
  toRefreshCallback,
  toTokenCallback,
  type VerifyJobPayload,
} from "@restow/core";
import {
  backupJobMembers,
  backupJobs,
  type Database,
  jobs,
  protectedObjects,
  type Source,
  safeErrorMessage,
  schedules,
  secrets,
  sources,
} from "@restow/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import PgBoss from "pg-boss";
import { type EntraAppLookup, processEntraApp } from "../entra-app.js";
import {
  postponeLoginProbe,
  reactivateAfterLogin,
  recordLoginFailure,
  recordLoginSuccess,
} from "../imap-login-state.js";
import { raiseInactiveNotices } from "../inactive-notices.js";
import type { TenantTxRunner } from "../progress.js";
import {
  InvalidPayloadError,
  type JobHandler,
  type JobOutcome,
  secretAad,
  tenantRunner,
  type WorkerJobContext,
} from "./framework.js";

type Env = Record<string, string | undefined>;

/** Sample size handed to a verify run scheduled after a backup (docs/TESTING.md). */
export const DEFAULT_VERIFY_SAMPLE_SIZE = 20;

/** Keys under `jobs.payload` this handler writes; the API reads the same names. */
export const RUNTIME_KEY = "runtime";
export const RESULT_KEY = "result";

/** Which source kind each protected-object kind belongs to. */
const SOURCE_KIND_OF: Record<ProtectedObjectKind, Source["kind"]> = {
  mailbox: "m365",
  onedrive: "m365",
  imap: "imap",
  site: "m365",
  group: "m365",
};

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EligibilityInput {
  readonly objectKind: ProtectedObjectKind;
  readonly objectStatus: "active" | "excluded" | "orphaned";
  /**
   * Why an orphaned mailbox is not backed up although its user is still in the directory
   * (`protected_objects.status_reason`); null or absent for an object removed from the source.
   * `login_refused` (an IMAP account an admin confirmed as shut down) is not a rejection: the
   * run probes the login first.
   */
  readonly objectStatusReason?: ObjectStatusReason | null;
  readonly sourceKind: Source["kind"];
  readonly sourceStatus: Source["status"];
}

/**
 * Why an object must not be backed up right now, or null when it may. Only
 * conditions an operator has to resolve are listed; a source in `error` state
 * is still attempted because the engine's own failure is the better diagnosis.
 */
export function backupRejection(input: EligibilityInput): string | null {
  if (SOURCE_KIND_OF[input.objectKind] !== input.sourceKind) {
    return `a ${input.objectKind} object cannot belong to a ${input.sourceKind} source`;
  }
  switch (input.objectStatus) {
    case "excluded":
      return "the object is excluded from protection";
    case "orphaned":
      if (input.objectStatusReason === "login_refused") {
        // A shut-down IMAP account is not rejected: the run probes its login (probeLoginRefused)
        // and goes on when it works again. The source checks below still apply, so a probe never
        // runs against a disabled or unconnected source.
        break;
      }
      if (input.objectStatusReason === "account_disabled") {
        return "the mailbox is not backed up: the account is disabled";
      }
      if (input.objectStatusReason === "no_license") {
        return "the mailbox is not backed up: the account has no Exchange Online licence";
      }
      if (input.objectStatusReason === "locked") {
        return "the object is not backed up: Microsoft locked it (HTTP 423)";
      }
      return "the object no longer exists in the source directory";
    default:
      break;
  }
  switch (input.sourceStatus) {
    case "pending":
      return "the source is not connected yet (admin consent or first connection outstanding)";
    case "disabled":
      return "the source is disabled";
    default:
      return null;
  }
}

/**
 * The failure cause behind a {@link backupRejection}, for the job's failure
 * record; null for a rejection without one (a kind that does not belong to
 * the source).
 */
export function backupRejectionCode(input: EligibilityInput): FailureCode | null {
  if (SOURCE_KIND_OF[input.objectKind] !== input.sourceKind) {
    return "config.invalid";
  }
  if (input.objectStatus === "excluded") {
    return "config.object_excluded";
  }
  if (input.objectStatus === "orphaned" && input.objectStatusReason !== "login_refused") {
    return input.objectStatusReason ? "config.object_inactive" : "config.object_orphaned";
  }
  if (input.sourceStatus === "pending") {
    return "config.source_not_connected";
  }
  return input.sourceStatus === "disabled" ? "config.source_disabled" : null;
}

// ---------------------------------------------------------------------------
// Runtime state: phase and throttling waits
// ---------------------------------------------------------------------------

/** The current (or last) throttling wait of a run, with running totals. */
export interface ThrottleState {
  /** HTTP status that caused the wait (429, 503, 504). */
  readonly status: number;
  readonly waitMs: number;
  /** What Graph asked for in Retry-After, when it said. */
  readonly retryAfterMs: number | null;
  /** ISO-8601 end of the current wait; the UI shows the wait only until then. */
  readonly until: string;
  /** Waits so far in this run and their summed duration. */
  readonly waits: number;
  readonly totalWaitMs: number;
}

/** What the API shows about a running job beyond the counters (`jobs.payload.runtime`). */
export interface BackupRuntimeState {
  /** Engine phase, e.g. "enumerate", "download", "manifest"; null once finished. */
  readonly phase: string | null;
  /** ISO-8601 time the phase began. */
  readonly phaseSince: string | null;
  readonly throttle: ThrottleState | null;
  /**
   * The run is the object's first backup: what earlier attempts stored and the
   * item total the source gave up front, if any (#47). The counters of this
   * attempt are in `job_progress`; the API adds the two up.
   */
  readonly firstBackup?: FirstBackupProgress | null;
}

export const IDLE_RUNTIME_STATE: BackupRuntimeState = {
  phase: null,
  phaseSince: null,
  throttle: null,
};

/** Fold one throttling wait into the state (pure). */
export function withThrottle(
  state: BackupRuntimeState,
  info: Pick<ThrottleInfo, "status" | "waitMs" | "retryAfterMs">,
  now: Date,
): BackupRuntimeState {
  const previous = state.throttle;
  return {
    ...state,
    throttle: {
      status: info.status,
      waitMs: info.waitMs,
      retryAfterMs: info.retryAfterMs,
      until: new Date(now.getTime() + info.waitMs).toISOString(),
      waits: (previous?.waits ?? 0) + 1,
      totalWaitMs: (previous?.totalWaitMs ?? 0) + info.waitMs,
    },
  };
}

/**
 * A ProgressReporter that forwards everything to the framework's reporter and
 * additionally persists phase changes and throttling waits. Writes are
 * serialized and never block the engine; a failed write is logged and the
 * next change tries again.
 */
export class PhaseRecorder implements ProgressReporter {
  private state: BackupRuntimeState = IDLE_RUNTIME_STATE;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: ProgressReporter,
    private readonly persist: (state: BackupRuntimeState) => Promise<void>,
    private readonly logger: Logger,
    private readonly now: () => Date,
  ) {}

  total(count: number): void {
    this.inner.total(count);
  }

  advance(done?: number, bytes?: number, processed?: number): void {
    this.inner.advance(done, bytes, processed);
  }

  /** Packs written to the repository (the run's "transferred" bytes). */
  transfer(bytes: number): void {
    this.inner.transfer?.(bytes);
  }

  fail(itemRef: string, reason: string, cause?: FailureCause, details?: ItemFailureDetails): void {
    // The item's own date (a message's received time) travels with it to `item_failures`.
    this.inner.fail(itemRef, reason, cause, details);
  }

  withdraw(failures: readonly ItemFailureRecord[]): void {
    this.inner.withdraw?.(failures);
  }

  phase(name: string): void {
    this.inner.phase(name);
    if (name === this.state.phase) {
      return;
    }
    this.record({ ...this.state, phase: name, phaseSince: this.now().toISOString() });
  }

  /** The engine runs the object's first backup; record what it knows about its size. */
  firstBackup(info: FirstBackupProgress): void {
    this.record({
      ...this.state,
      firstBackup: { itemsBefore: info.itemsBefore, itemsTotal: info.itemsTotal },
    });
  }

  /** Graph made the run wait; record it so the UI can show the wait honestly. */
  throttled(info: ThrottleInfo): void {
    this.logger.info("waiting for Microsoft Graph (throttled)", {
      status: info.status,
      attempt: info.attempt,
      waitMs: info.waitMs,
      retryAfterMs: info.retryAfterMs,
    });
    this.record(withThrottle(this.state, info, this.now()));
  }

  /** Waits so far in this run (for the stored result). */
  throttleTotals(): { waits: number; totalWaitMs: number } {
    return {
      waits: this.state.throttle?.waits ?? 0,
      totalWaitMs: this.state.throttle?.totalWaitMs ?? 0,
    };
  }

  snapshot(): ProgressSnapshot {
    return this.inner.snapshot();
  }

  /** Clear the runtime state (the run is over) and wait for every pending write. */
  async finish(): Promise<void> {
    const totals = this.state.throttle;
    this.record(IDLE_RUNTIME_STATE);
    // Keep the totals readable for the result after the persisted state is cleared.
    this.state = { ...IDLE_RUNTIME_STATE, throttle: totals };
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.pending;
    await this.inner.flush();
  }

  private record(next: BackupRuntimeState): void {
    this.state = next;
    this.pending = this.pending
      .then(() => this.persist(next))
      .catch((error: unknown) => {
        this.logger.warn("could not persist job runtime state", {
          phase: next.phase,
          errorMessage: safeErrorMessage(error),
        });
      });
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** `jobs.payload.result` of a finished backup (read by the API's job detail). */
export interface StoredBackupResult {
  readonly snapshotId: string;
  readonly sequence: number;
  readonly objectsWritten: number;
  readonly objectsTotal: number;
  readonly bytes: number;
  readonly failures: number;
  readonly repairedCopies: number;
  readonly verifyJobId: string | null;
  readonly throttleWaits: number;
  readonly throttleWaitMs: number;
  readonly completedAt: string;
  /** What the run changed, for the ransomware judgement (apps/worker suspicion); OneDrive only. */
  readonly activity?: ActivityReport;
  /**
   * The chunk writer's bytes chunked, new and the compressibility sample, for the compression and
   * deduplication signals (apps/worker suspicion); results from before 0.4.x have none.
   */
  readonly chunkStats?: ChunkDataStats;
}

export function toStoredBackupResult(input: {
  readonly result: BackupResult;
  readonly repairedCopies: number;
  readonly verifyJobId: string | null;
  readonly throttle: { waits: number; totalWaitMs: number };
  readonly completedAt: Date;
}): StoredBackupResult {
  const { result } = input;
  return {
    snapshotId: result.snapshotId,
    sequence: result.sequence,
    objectsWritten: result.objectsWritten,
    objectsTotal: result.objectsTotal,
    bytes: result.bytes,
    // An earlier attempt's failures (a resumed site) were reported then; they still count here.
    failures: result.failures.length + (result.failuresFromEarlierAttempts ?? 0),
    repairedCopies: input.repairedCopies,
    verifyJobId: input.verifyJobId,
    throttleWaits: input.throttle.waits,
    throttleWaitMs: input.throttle.totalWaitMs,
    completedAt: input.completedAt.toISOString(),
    ...(result.activity ? { activity: result.activity } : {}),
    ...(result.chunkStats ? { chunkStats: result.chunkStats } : {}),
  };
}

// ---------------------------------------------------------------------------
// Copy targets
// ---------------------------------------------------------------------------

/**
 * Packs and manifests are written to every target as the engine goes (the
 * chunk store fails the job when a copy refuses a write). This final check
 * heals a copy target that nonetheless misses the manifest, so every target
 * stays complete for a standalone restore. Returns the number of repairs.
 */
export async function ensureManifestOnCopies(
  storage: StorageTargets,
  manifestPath: string,
  logger: Logger,
): Promise<number> {
  let repaired = 0;
  let bytes: Buffer | null = null;
  for (const copy of storage.copies) {
    if ((await copy.head(manifestPath)) !== null) {
      continue;
    }
    bytes ??= await storage.primary.get(manifestPath);
    await copy.put(manifestPath, bytes);
    repaired++;
    logger.warn("manifest was missing on a copy target and has been written", {
      key: manifestPath,
    });
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// Persistence seam
// ---------------------------------------------------------------------------

export interface QueuedJobRow {
  readonly jobId: string;
  readonly queue: "verify";
  readonly protectedObjectId: string;
  readonly payload: Record<string, unknown>;
  readonly pgBossJobId: string;
}

export interface ObjectSource {
  readonly objectStatus: EligibilityInput["objectStatus"];
  /** See {@link EligibilityInput.objectStatusReason}; absent reads as null. */
  readonly objectStatusReason?: ObjectStatusReason | null;
  readonly source: Source;
  /**
   * The protected object's own sealed IMAP password (`protected_objects.secret_ref`),
   * used only when the source's `imapAuthMode` is `"per_mailbox"`; null otherwise
   * (including every non-IMAP object).
   */
  readonly objectSecretRef: string | null;
}

/** Everything the handler reads or writes outside the engine seams; Postgres by default. */
export interface BackupStore {
  loadSource(object: ProtectedObjectRef): Promise<ObjectSource>;
  persistRuntimeState(jobId: string, state: BackupRuntimeState): Promise<void>;
  persistResult(jobId: string, result: StoredBackupResult): Promise<void>;
  /**
   * The enabled verify schedule covering the object (its own first, else the
   * tenant-wide one), or null when restore checks are not scheduled.
   */
  verifyScheduleId(protectedObjectId: string): Promise<string | null>;
  /**
   * The enabled mail job whose restore checks cover the object (its own override first, else the
   * job's; an "all" job covers an object that is in no job), or null. A job comes before the
   * schedules: they only remain for what no job could take over.
   */
  verifyBackupJobId(protectedObjectId: string): Promise<string | null>;
  /** Record a job the handler enqueued; a row the worker already upserted wins. */
  insertQueuedJob(row: QueuedJobRow): Promise<void>;
  /** Re-seal a secret whose plaintext changed (a rotated OAuth2 refresh token). */
  replaceSecret(secretId: string, plaintext: string): Promise<void>;
  /**
   * Mark an active object inactive (`orphaned` with a reason) after Microsoft confirmed that its
   * account is disabled or unlicensed, or that its OneDrive or site is locked; true when the row
   * changed. Only an `active` object is changed: one an operator excluded meanwhile, or a sync
   * already orphaned, stays as it is. The one-time notice (inactive-notices.ts) is raised in the
   * same transaction. Absent in stores that have no objects table (tests): the run still ends
   * neutral.
   */
  markInactive?(protectedObjectId: string, reason: ObjectStatusReason): Promise<boolean>;
  /**
   * A password login of an IMAP account was refused (a failed run, or the probe of a shut-down
   * account): counts it, and opens the question "was this account shut down?" after enough
   * (imap-login-state.ts). Optional like {@link markInactive}.
   */
  recordLoginFailure?(protectedObjectId: string): Promise<void>;
  /** A login worked: the streak and an open question of the account are over. */
  recordLoginSuccess?(protectedObjectId: string): Promise<void>;
  /** The probe of a shut-down account worked: it is active again; true when the row changed. */
  reactivateAfterLogin?(protectedObjectId: string): Promise<boolean>;
  /** The probe of a shut-down account could not tell: the next one is due in `days` days. */
  postponeLoginProbe?(protectedObjectId: string, days: number): Promise<void>;
}

/**
 * Merge `patch` into `jobs.payload` without reading the payload back. Shared
 * by every handler that keeps `runtime` or `result` there (restore, directory).
 */
export async function mergeJobPayload(
  run: TenantTxRunner,
  tenantId: string,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const json = JSON.stringify(patch);
  await run((tx) =>
    tx
      .update(jobs)
      .set({ payload: sql`coalesce(${jobs.payload}, '{}'::jsonb) || ${json}::jsonb` })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId))),
  );
}

/**
 * Every query names the tenant explicitly, on top of Row Level Security (the
 * same discipline as the framework's own stores).
 */
export function pgBackupStore(
  run: TenantTxRunner,
  tenantId: string,
  keys: TenantKeyring,
): BackupStore {
  return {
    async loadSource(object) {
      const [row] = await run((tx) =>
        tx
          .select({
            objectStatus: protectedObjects.status,
            objectStatusReason: protectedObjects.statusReason,
            source: sources,
            objectSecretRef: protectedObjects.secretRef,
          })
          .from(protectedObjects)
          .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
          .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, object.id)))
          .limit(1),
      );
      if (!row) {
        throw new InvalidPayloadError(`protected object ${object.id} has no source`);
      }
      return row;
    },

    async persistRuntimeState(jobId, state) {
      await mergeJobPayload(run, tenantId, jobId, { [RUNTIME_KEY]: state });
    },

    async persistResult(jobId, result) {
      await mergeJobPayload(run, tenantId, jobId, { [RESULT_KEY]: result });
    },

    async verifyScheduleId(protectedObjectId) {
      const [row] = await run((tx) =>
        tx
          .select({ id: schedules.id })
          .from(schedules)
          .where(
            and(
              eq(schedules.tenantId, tenantId),
              eq(schedules.kind, "verify"),
              eq(schedules.enabled, true),
              // A schedule a job took over is the job's now (verifyBackupJobId).
              isNull(schedules.supersededByJobId),
              or(
                isNull(schedules.protectedObjectId),
                eq(schedules.protectedObjectId, protectedObjectId),
              ),
            ),
          )
          .orderBy(sql`${schedules.protectedObjectId} IS NULL`)
          .limit(1),
      );
      return row?.id ?? null;
    },

    async verifyBackupJobId(protectedObjectId) {
      return run(async (tx) => {
        const [member] = await tx
          .select({
            jobId: backupJobs.id,
            enabled: backupJobs.enabled,
            verifySchedule: backupJobs.verifySchedule,
            overrides: backupJobMembers.overrides,
          })
          .from(backupJobMembers)
          .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
          .where(
            and(
              eq(backupJobMembers.tenantId, tenantId),
              eq(backupJobMembers.protectedObjectId, protectedObjectId),
              eq(backupJobs.kind, "mail"),
            ),
          )
          .limit(1);
        if (member) {
          return member.enabled && (member.overrides?.verifySchedule ?? member.verifySchedule)
            ? member.jobId
            : null;
        }
        const [covering] = await tx
          .select({ id: backupJobs.id, verifySchedule: backupJobs.verifySchedule })
          .from(backupJobs)
          .where(
            and(
              eq(backupJobs.tenantId, tenantId),
              eq(backupJobs.kind, "mail"),
              eq(backupJobs.scopeMode, "all"),
              eq(backupJobs.enabled, true),
            ),
          )
          .limit(1);
        return covering?.verifySchedule ? covering.id : null;
      });
    },

    async insertQueuedJob(row) {
      await run((tx) =>
        tx
          .insert(jobs)
          .values({
            id: row.jobId,
            tenantId,
            queue: row.queue,
            status: "queued",
            protectedObjectId: row.protectedObjectId,
            payload: row.payload,
            pgBossJobId: row.pgBossJobId,
          })
          .onConflictDoNothing({ target: jobs.id }),
      );
    },

    async markInactive(protectedObjectId, reason) {
      return run(async (tx) => {
        const rows = await tx
          .update(protectedObjects)
          .set({ status: "orphaned", statusReason: reason, updatedAt: sql`now()` })
          .where(
            and(
              eq(protectedObjects.tenantId, tenantId),
              eq(protectedObjects.id, protectedObjectId),
              eq(protectedObjects.status, "active"),
            ),
          )
          .returning({ id: protectedObjects.id });
        if (rows.length > 0) {
          // Amber "please confirm" from now on: tell the admins once (with the row change).
          await raiseInactiveNotices(tx, tenantId);
        }
        return rows.length > 0;
      });
    },

    async recordLoginFailure(protectedObjectId) {
      await run((tx) => recordLoginFailure(tx, tenantId, protectedObjectId));
    },

    async recordLoginSuccess(protectedObjectId) {
      await run((tx) => recordLoginSuccess(tx, tenantId, protectedObjectId));
    },

    async reactivateAfterLogin(protectedObjectId) {
      return run((tx) => reactivateAfterLogin(tx, tenantId, protectedObjectId));
    },

    async postponeLoginProbe(protectedObjectId, days) {
      await run((tx) => postponeLoginProbe(tx, tenantId, protectedObjectId, days));
    },

    async replaceSecret(secretId, plaintext) {
      // Same sealing as the API (apps/api/src/lib/secrets.ts): the tenant's
      // current DEK, bound to the secret's own row id.
      const key = keys.current;
      const ciphertext = encryptChunk(
        key,
        Buffer.from(plaintext, "utf8"),
        secretAad(secretId),
      ).toString("base64");
      await run((tx) =>
        tx
          .update(secrets)
          .set({ ciphertext, keyVersion: key.version })
          .where(and(eq(secrets.tenantId, tenantId), eq(secrets.id, secretId))),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/** What an engine factory gets for one job. */
export interface BackupEngineDeps {
  readonly ctx: WorkerJobContext;
  readonly source: Source;
  readonly store: BackupStore;
  /** The object's own sealed IMAP password, when its source uses `per_mailbox` auth. */
  readonly objectSecretRef: string | null;
  /** Report a throttling wait (wired into the Graph client). */
  readonly throttled: (info: ThrottleInfo) => void;
}

/**
 * Builds the engine for one job. Engines are cheap objects; building them per
 * job lets each one close over its own source, credentials and throttle hook.
 */
export type BackupEngineFactory = (deps: BackupEngineDeps) => BackupEngine<Database>;

/**
 * Asks the source, after a failed mailbox backup, whether the mailbox is inactive (account
 * disabled, no licence) rather than broken; null when the source does not clearly say so.
 */
export type InactiveCheck = (
  deps: BackupEngineDeps,
  object: ProtectedObjectRef,
) => Promise<ObjectStatusReason | null>;

/**
 * Asks the source, after a OneDrive or site backup met a 423 lock, whether the whole object is
 * locked (core directory/locks.ts): true locked, false readable, null when it does not say.
 */
export type LockCheck = (
  deps: BackupEngineDeps,
  object: ProtectedObjectRef,
) => Promise<boolean | null>;

/**
 * Logs in to an IMAP account once and out again (the weekly probe of an account an admin
 * confirmed as shut down). Throws what the login throws.
 */
export type LoginProbe = (deps: BackupEngineDeps, object: ProtectedObjectRef) => Promise<void>;

/** Engine factories by protected-object kind. Registering a kind twice replaces it. */
export class BackupEngineRegistry {
  private readonly factories = new Map<ProtectedObjectKind, BackupEngineFactory>();
  /** The check behind {@link confirmInactiveAfterFailure}; null skips it (tests, other builds). */
  inactiveCheck: InactiveCheck | null = null;
  /** The lock check behind {@link confirmInactiveAfterFailure}; null skips it. */
  lockCheck: LockCheck | null = null;
  /** The login probe behind {@link probeLoginRefused}; null ends such a run neutral, unprobed. */
  loginProbe: LoginProbe | null = null;

  constructor(entries: Iterable<readonly [ProtectedObjectKind, BackupEngineFactory]> = []) {
    for (const [kind, factory] of entries) {
      this.register(kind, factory);
    }
  }

  register(kind: ProtectedObjectKind, factory: BackupEngineFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  get(kind: ProtectedObjectKind): BackupEngineFactory | undefined {
    return this.factories.get(kind);
  }

  kinds(): ProtectedObjectKind[] {
    return [...this.factories.keys()];
  }
}

/** The factory for a kind, or a non-retriable rejection naming what is missing. */
export function selectBackupEngine(
  registry: BackupEngineRegistry,
  kind: ProtectedObjectKind,
): BackupEngineFactory {
  const factory = registry.get(kind);
  if (!factory) {
    const available = registry.kinds();
    const hint = available.length > 0 ? ` (available: ${available.join(", ")})` : "";
    throw new InvalidPayloadError(
      `no backup engine for protected objects of kind "${kind}" in this build${hint}`,
    );
  }
  return factory;
}

/**
 * One token provider per customer tenant and credential, shared by every job
 * of the process: a token is fetched once and reused until it nears expiry,
 * instead of once per mailbox. Keys hold the credential's fingerprint (a
 * digest), never the credential, so a rotated secret gets a provider of its own.
 */
export class TokenProviderCache {
  private readonly providers = new Map<string, ClientCredentialsTokenProvider>();

  constructor(private readonly limit = 256) {}

  static keyOf(entraTenantId: string, app: AppCredentials): string {
    return `${entraTenantId}:${appCredentialsFingerprint(app)}`;
  }

  get(entraTenantId: string, app: AppCredentials): ClientCredentialsTokenProvider {
    const key = TokenProviderCache.keyOf(entraTenantId, app);
    let provider = this.providers.get(key);
    if (!provider) {
      provider = new ClientCredentialsTokenProvider({ tenantId: entraTenantId, app });
      if (this.providers.size >= this.limit) {
        const oldest = this.providers.keys().next().value;
        if (oldest !== undefined) {
          this.providers.delete(oldest);
        }
      }
      this.providers.set(key, provider);
    }
    return provider;
  }

  get size(): number {
    return this.providers.size;
  }
}

export interface GraphSettings {
  /** The process environment (IMAP transport rules). */
  readonly env: Env;
  /** The backup app registration, resolved at the time of use (../entra-app.ts). */
  readonly entraApp: EntraAppLookup;
  readonly tokens: TokenProviderCache;
}

/**
 * The backup app's credentials for a source: the app registration in use
 * (environment, else Settings → Microsoft 365), with the source's own client
 * secret in place of the app's credential when it has one.
 */
export async function appCredentialsForSource(
  deps: Pick<BackupEngineDeps, "ctx" | "source">,
  settings: Pick<GraphSettings, "entraApp">,
): Promise<AppCredentials> {
  const { ctx, source } = deps;
  const perSourceSecret = source.secretRef ? await ctx.secrets.get(source.secretRef) : null;
  if (perSourceSecret) {
    // The source's own Graph app (a customer's app entered by hand): nothing of the shared
    // registration is involved.
    let own: AppCredentials | null;
    try {
      own = parseSourceAppSecret(perSourceSecret);
    } catch (error) {
      throw new InvalidPayloadError(
        error instanceof Error ? error.message : "the saved app of this source is unusable",
        buildCause("config.app_not_configured"),
      );
    }
    if (own) {
      return own;
    }
  }
  const resolution = await settings.entraApp.resolve();
  if (perSourceSecret) {
    const app = resolution.status === "ready" ? resolution.app.credentials : null;
    // Without a usable registration, a lone ENTRA_CLIENT_ID still names the app.
    const clientId = app?.clientId ?? (resolution.status === "ready" ? null : resolution.clientId);
    if (clientId) {
      return {
        clientId,
        credential: { type: "secret", clientSecret: perSourceSecret },
        ...(app?.authorityHost ? { authorityHost: app.authorityHost } : {}),
      };
    }
  }
  const usable = entraAppCredentialsOf(resolution);
  if (!usable.ok) {
    // A configuration problem: retrying cannot fix it, the operator can.
    throw new InvalidPayloadError(usable.detail, buildCause("config.app_not_configured"));
  }
  return usable.app.credentials;
}

/** Client-credentials Graph client for the source's customer tenant, reporting throttling waits. */
export async function graphClientForSource(
  deps: BackupEngineDeps,
  settings: GraphSettings,
): Promise<GraphClient> {
  const { source } = deps;
  if (!source.entraTenantId) {
    throw new InvalidPayloadError(
      `source "${source.name}" has no Entra tenant id; admin consent is outstanding`,
      buildCause("config.source_not_connected"),
    );
  }
  const app = await appCredentialsForSource(deps, settings);
  const tokens = settings.tokens.get(source.entraTenantId, app);
  return new FetchGraphClient({
    accessTokenProvider: toTokenCallback(tokens),
    refreshAccessToken: toRefreshCallback(tokens),
    onThrottle: deps.throttled,
    // A hanging request or throttling wait ends with the job (cancel, time limit, restart).
    signal: deps.ctx.signal,
  });
}

/** Resolve the Graph client once per job, on first use. */
function lazyGraphClient(
  deps: BackupEngineDeps,
  settings: GraphSettings,
): () => Promise<GraphClient> {
  let client: Promise<GraphClient> | null = null;
  return () => {
    client ??= graphClientForSource(deps, settings);
    return client;
  };
}

/** Whether the operator lets every IMAP source reach loopback and private networks. */
export function imapPrivateNetworksAllowed(env: Env): boolean {
  return env.IMAP_ALLOW_PRIVATE_NETWORKS?.trim().toLowerCase() === "true";
}

/**
 * The IMAP account behind a protected object. The server always comes from
 * the source; the login and credential depend on `SourceConfig.imapAuthMode`
 * (docs/IMAP.md, default `"shared"` when absent, unchanged since before this
 * mode existed):
 *
 *   - `shared` (default): one login and secret on the source itself, the
 *     login is the object's own external id (one `imap` object per login).
 *   - `per_mailbox`: the object's own sealed password
 *     (`protected_objects.secret_ref`, passed in as `objectSecretRef`), login
 *     is again the object's external id. Hosters with one password per
 *     mailbox and no master user (Hetzner, IONOS, all-inkl) need this. A
 *     missing credential fails this object with a clear, non-secret cause
 *     rather than connecting with nothing.
 *   - `master_user`: one shared master account (`source.secretRef`)
 *     impersonates the mailbox, shaped by `SourceConfig.masterUser`: the
 *     Dovecot `master*mailbox` username separator, or SASL PLAIN authzid
 *     (login stays the master, `authzid` carries the mailbox).
 *
 * The host may lie in a private network only when the operator allowed that
 * for the installation or a provider admin approved it for this source; the
 * connector enforces it on every connection (@restow/core net/address-policy.ts).
 */
export function imapAccountFor(
  source: Source,
  object: ProtectedObjectRef,
  objectSecretRef: string | null = null,
  env: Env = process.env,
): ImapAccountConfig {
  if (source.kind !== "imap") {
    throw new InvalidPayloadError(`source "${source.name}" is not an IMAP source`);
  }
  if (!source.host || !source.port || !source.security) {
    throw new InvalidPayloadError(`IMAP source "${source.name}" has no server configured`);
  }
  const base = {
    host: source.host,
    port: source.port,
    security: source.security,
    allowPrivateNetwork:
      imapPrivateNetworksAllowed(env) || Boolean(source.config.privateNetworkApproval),
  };
  const mode = source.config.imapAuthMode ?? "shared";

  if (mode === "per_mailbox") {
    if (!objectSecretRef) {
      throw new InvalidPayloadError(
        `IMAP account "${object.externalId}" on source "${source.name}" has no password set; add one before it can be backed up`,
        buildCause("imap.credential_missing"),
      );
    }
    return {
      ...base,
      username: object.externalId,
      authKind: "password",
      secretId: objectSecretRef,
    };
  }

  if (mode === "master_user") {
    if (!source.secretRef) {
      throw new InvalidPayloadError(`IMAP source "${source.name}" has no master credential stored`);
    }
    const masterUser = source.config.masterUser;
    if (!masterUser?.username) {
      throw new InvalidPayloadError(`IMAP source "${source.name}" has no master user configured`);
    }
    if (masterUser.style === "sasl_authzid") {
      return {
        ...base,
        username: masterUser.username,
        authzid: object.externalId,
        authKind: "password",
        secretId: source.secretRef,
      };
    }
    const separator = masterUser.separator ?? "*";
    return {
      ...base,
      username: `${masterUser.username}${separator}${object.externalId}`,
      authKind: "password",
      secretId: source.secretRef,
    };
  }

  // shared (default): unchanged since before per-mailbox and master-user auth existed.
  if (!source.secretRef) {
    throw new InvalidPayloadError(
      `IMAP source "${source.name}" has no stored credential`,
      buildCause("imap.credential_missing"),
    );
  }
  return {
    ...base,
    username: object.externalId,
    authKind: source.config.authKind ?? "password",
    secretId: source.secretRef,
  };
}

/** The IMAP engine of one job: the account from the source, the transport rule, token rotation. */
function imapEngineFor(deps: BackupEngineDeps, env: Env): ImapBackupEngine {
  return new ImapBackupEngine({
    resolveAccount: async (_ctx, object) =>
      imapAccountFor(deps.source, object, deps.objectSecretRef, env),
    allowInsecure: env.IMAP_ALLOW_INSECURE?.trim().toLowerCase() === "true",
    onRefreshTokenRotated: (secretId, secretJson) => deps.store.replaceSecret(secretId, secretJson),
  });
}

export interface DefaultEngineOptions {
  readonly env?: Env;
  readonly entraApp?: EntraAppLookup;
  readonly tokens?: TokenProviderCache;
}

/**
 * The engines this build ships: Exchange mailboxes, OneDrive, IMAP accounts,
 * SharePoint sites and the group mailboxes of Microsoft 365 groups. Sites and
 * group mailboxes use the same lazily built, throttled Graph client as OneDrive,
 * so Retry-After and the per-tenant limits apply to them alike.
 */
export function createDefaultBackupEngines(
  options: DefaultEngineOptions = {},
): BackupEngineRegistry {
  const settings: GraphSettings = {
    env: options.env ?? process.env,
    entraApp: options.entraApp ?? processEntraApp,
    tokens: options.tokens ?? new TokenProviderCache(),
  };
  const registry = new BackupEngineRegistry([
    ["mailbox", (deps) => new ExchangeBackupEngine({ graph: lazyGraphClient(deps, settings) })],
    [
      "onedrive",
      (deps) => new OneDriveBackupEngine<Database>({ graph: lazyGraphClient(deps, settings) }),
    ],
    [
      "site",
      (deps) => new SharePointBackupEngine<Database>({ graph: lazyGraphClient(deps, settings) }),
    ],
    [
      "group",
      (deps) => new GroupMailboxBackupEngine<Database>({ graph: lazyGraphClient(deps, settings) }),
    ],
    ["imap", (deps) => imapEngineFor(deps, settings.env)],
  ]);
  registry.inactiveCheck = async (deps, object) => {
    const graph = await graphClientForSource(deps, settings);
    return (await confirmMailboxInactive(graph, object.externalId))?.reason ?? null;
  };
  registry.loginProbe = (deps, object) =>
    imapEngineFor(deps, settings.env).probeLogin(deps.ctx, object);
  registry.lockCheck = async (deps, object) => {
    if (object.kind !== "onedrive" && object.kind !== "site") {
      return null;
    }
    const graph = await graphClientForSource(deps, settings);
    return confirmObjectLocked(graph, object.kind, object.externalId);
  };
  return registry;
}

// ---------------------------------------------------------------------------
// Disabled and unlicensed mailboxes
// ---------------------------------------------------------------------------

/**
 * Failure causes of a mailbox backup that may mean "the account is disabled or unlicensed",
 * worth one confirming read (core directory/confirm.ts). Never a 401 or 403 cause
 * (`graph.access_denied`, `graph.permission_missing`, `graph.token_rejected`): those are
 * permission problems and stay failures. `graph.request_rejected` only with 400 or 404.
 */
export function mayBeInactiveMailbox(cause: FailureCause): boolean {
  if (cause.code === "graph.mailbox_not_licensed" || cause.code === "graph.user_not_found") {
    return true;
  }
  const status = cause.params.httpStatus;
  return cause.code === "graph.request_rejected" && (status === 400 || status === 404);
}

/**
 * After a failed mailbox backup: when the failure may mean an inactive account and Microsoft
 * confirms it, mark the object inactive and return the neutral rejection to throw instead
 * (`graph.mailbox_inactive`, final, no retry, the original technical details kept); null
 * otherwise, and the original error stands. Never throws: a check that fails leaves the run's
 * own failure in place.
 */
export async function confirmInactiveAfterFailure(input: {
  readonly error: unknown;
  readonly object: ProtectedObjectRef;
  readonly check: InactiveCheck | null;
  readonly lockCheck?: LockCheck | null;
  readonly deps: BackupEngineDeps;
  readonly store: BackupStore;
  readonly logger: Logger;
}): Promise<InvalidPayloadError | null> {
  const { error, object, check, deps, store, logger } = input;
  if (deps.source.kind !== "m365") {
    return null;
  }
  const cause = classifyFailure(error);
  if (
    (object.kind === "onedrive" || object.kind === "site") &&
    cause.code === "graph.object_locked"
  ) {
    return (
      (await confirmLockedAfterFailure({ ...input, cause, lockCheck: input.lockCheck ?? null })) ??
      unconfirmedLockFailure(error)
    );
  }
  if (object.kind !== "mailbox" || !check) {
    return null;
  }
  if (!mayBeInactiveMailbox(cause)) {
    return null;
  }
  let reason: ObjectStatusReason | null;
  try {
    reason = await check(deps, object);
  } catch (checkError) {
    logger.warn("checking whether the mailbox is inactive did not succeed", {
      error: checkError,
    });
    return null;
  }
  if (!reason) {
    return null;
  }
  const marked = (await store.markInactive?.(object.id, reason)) ?? false;
  logger.info("mailbox is inactive at the source, not backed up", { reason, marked });
  const params = {
    reason,
    ...(cause.params.graphCode !== undefined ? { graphCode: cause.params.graphCode } : {}),
    ...(cause.params.httpStatus !== undefined ? { httpStatus: cause.params.httpStatus } : {}),
  };
  return new InvalidPayloadError(
    reason === "account_disabled"
      ? "mailbox not backed up: the account is disabled"
      : "mailbox not backed up: the account has no Exchange Online licence",
    buildCause("graph.mailbox_inactive", params, cause.technical),
  );
}

/**
 * A OneDrive or site whose backup met a drive- or site-level 423 lock (Microsoft locks the
 * OneDrive of an unlicensed account, an admin can lock a site): when one more cheap read meets
 * the lock again (core directory/locks.ts), the object is marked `orphaned` with the reason
 * `locked` (amber until confirmed, no nightly runs any more, the scheduler only plans active
 * objects) and the run ends final and neutral (`graph.object_locked`, original details kept).
 * Null when the read gets through, says nothing or fails: the caller then turns the run's own
 * error into a counted failure ({@link unconfirmedLockFailure}), never a neutral one.
 */
async function confirmLockedAfterFailure(input: {
  readonly object: ProtectedObjectRef;
  readonly cause: FailureCause;
  readonly lockCheck: LockCheck | null;
  readonly deps: BackupEngineDeps;
  readonly store: BackupStore;
  readonly logger: Logger;
}): Promise<InvalidPayloadError | null> {
  const { object, cause, lockCheck, deps, store, logger } = input;
  if (!lockCheck) {
    return null;
  }
  let locked: boolean | null;
  try {
    locked = await lockCheck(deps, object);
  } catch (checkError) {
    logger.warn("checking whether the object is locked did not succeed", { error: checkError });
    return null;
  }
  if (locked !== true) {
    return null;
  }
  const marked = (await store.markInactive?.(object.id, "locked")) ?? false;
  logger.info("object is locked at the source, not backed up", { marked });
  return new InvalidPayloadError(
    `${object.kind === "site" ? "site" : "OneDrive"} not backed up: Microsoft locked it (HTTP 423)`,
    buildCause("graph.object_locked", { ...cause.params, reason: "locked" }, cause.technical),
  );
}

/**
 * After a failed IMAP run: a refused password login counts towards the question "was this
 * account shut down?" (imap-login-state.ts). Best effort: a failure to record must not mask the
 * run's own error.
 */
async function countRefusedLogin(input: {
  readonly error: unknown;
  readonly object: ProtectedObjectRef;
  readonly store: BackupStore;
  readonly logger: Logger;
}): Promise<void> {
  const { error, object, store, logger } = input;
  if (object.kind !== "imap" || !isLoginRefusalCause(classifyFailure(error))) {
    return;
  }
  try {
    await store.recordLoginFailure?.(object.id);
  } catch (recordError) {
    logger.warn("could not record the refused login", {
      errorMessage: safeErrorMessage(recordError),
    });
  }
}

/**
 * A drive- or site-level 423 the lock probe did not confirm (probe 200, 429/5xx/403, a thrown
 * check, no check, a cancelled run): `graph.object_locked` is neutral (failures/limits.ts), but
 * the object stays `active`, so leaving it would end every night neutral with no failure, no
 * amber state and no notice while backups silently stop. Only a confirmed lock is neutral: this
 * one becomes `graph.request_rejected` (counted, `backup.failed`, original details kept, the
 * `locked` reason dropped so nothing reads it as "not backed up"). Null for any other error.
 */
export function unconfirmedLockFailure(error: unknown): InvalidPayloadError | null {
  const cause = classifyFailure(error);
  if (cause.code !== "graph.object_locked") {
    return null;
  }
  const { reason: _reason, ...params } = cause.params;
  return new InvalidPayloadError(
    error instanceof Error ? error.message : "request rejected with HTTP 423 (lock unconfirmed)",
    buildCause("graph.request_rejected", params, cause.technical),
  );
}

// ---------------------------------------------------------------------------
// Shut-down IMAP accounts: the login probe
// ---------------------------------------------------------------------------

/**
 * The first step of a backup run for an IMAP account an admin confirmed as shut down
 * (`orphaned` + `login_refused`, docs/IMAP.md): log in once, through the engine's own account,
 * transport rule and token handling, before anything else.
 *
 *   - The login works: the account is active again (`active_since` starts now) and the run goes
 *     on into the normal backup. Returns.
 *   - The login is refused (`imap.auth_failed`): the next probe is a week out and the run ends
 *     neutral and final (`config.object_inactive`, reason `login_refused`: no `backup.failed`,
 *     no `job.failed`).
 *   - Anything else (network, server limit, configuration, no probe in this build): the run ends
 *     the same way, the next probe is a day out, and the account stays as it is. A doubtful
 *     answer never reactivates.
 *
 * A cancelled run rethrows its own error and moves nothing.
 */
export async function probeLoginRefused(input: {
  readonly deps: BackupEngineDeps;
  readonly probe: LoginProbe | null;
  readonly object: ProtectedObjectRef;
  readonly store: BackupStore;
  readonly logger: Logger;
}): Promise<void> {
  const { deps, probe, object, store, logger } = input;
  const neutral = (message: string, technical?: FailureCause["technical"]) =>
    new InvalidPayloadError(
      message,
      buildCause("config.object_inactive", { reason: "login_refused" }, technical),
    );
  try {
    if (!probe) {
      throw new Error("this build has no login probe");
    }
    await probe(deps, object);
  } catch (error) {
    if (deps.ctx.signal.aborted) {
      throw error;
    }
    const cause = classifyFailure(error);
    // The run ends neutral either way; a bookkeeping failure only means the planner asks again
    // sooner (the due date did not move), so it never replaces the run's own outcome.
    const remember = async (write: (() => Promise<void>) | undefined) => {
      try {
        await write?.();
      } catch (writeError) {
        logger.warn("could not record the outcome of the login probe", {
          errorMessage: safeErrorMessage(writeError),
        });
      }
    };
    if (isLoginRefusalCause(cause)) {
      await remember(() => store.recordLoginFailure?.(object.id) ?? Promise.resolve());
      // recordLoginFailure moves the due date only for a password login of a row that is still
      // shut down; a source switched to OAuth2 meanwhile, or a write that failed, would leave it
      // in the past and the planner would probe every hour. This update has no such filter.
      await remember(
        () =>
          store.postponeLoginProbe?.(object.id, LOGIN_PROBE_INTERVAL_HOURS / 24) ??
          Promise.resolve(),
      );
      logger.info("login of the shut-down account is still refused; probing again in a week");
      throw neutral("login still refused: the account stays shut down", cause.technical);
    }
    await remember(() => store.postponeLoginProbe?.(object.id, 1) ?? Promise.resolve());
    logger.warn("could not check the login of the shut-down account; probing again tomorrow", {
      code: cause.code,
    });
    throw neutral("could not check the login of the shut-down account", cause.technical);
  }
  const restored = (await store.reactivateAfterLogin?.(object.id)) ?? false;
  if (!restored) {
    // Nothing changed: an admin excluded the account, or reactivated it, since the run read its
    // status (or the store cannot reactivate). Back it up only when it is active now; an
    // excluded account must not get a snapshot.
    const current = await store.loadSource(object);
    if (current.objectStatus !== "active") {
      logger.info("the shut-down account is no longer shut down, but not active either", {
        status: current.objectStatus,
      });
      throw neutral("login works, but the account is not active: nothing to back up");
    }
  }
  logger.info("login of the shut-down account works again, backing it up", { restored });
}

// ---------------------------------------------------------------------------
// Follow-up verify
// ---------------------------------------------------------------------------

/** Sends a job to pg-boss; null when the singleton key is already queued or active. */
export type JobSender = (
  queue: "verify",
  payload: VerifyJobPayload,
  options: PgBoss.SendOptions,
) => Promise<string | null>;

const bossByPool = new WeakMap<object, PgBoss>();

/**
 * A pg-boss instance sending through the database's own pool; `send` needs no
 * `start()`. Exported so other handlers that enqueue a follow-up job (the
 * directory handler's first backup after a sync) share the same instance per
 * pool instead of opening another one.
 */
export function bossFor(db: Database): PgBoss {
  const pool = db.$client;
  let boss = bossByPool.get(pool);
  if (!boss) {
    boss = new PgBoss({
      db: {
        executeSql: async (text, values) => {
          const result = await pool.query(text, values);
          return { rows: result.rows };
        },
      },
    });
    bossByPool.set(pool, boss);
  }
  return boss;
}

/**
 * Enqueue a sampled restore check for the object when the tenant scheduled
 * verification. Returns the new job id, or null when nothing was enqueued
 * (no schedule, or a verify for the object is already queued or running).
 */
export async function enqueueVerifyAfterBackup(options: {
  readonly store: BackupStore;
  readonly tenantId: string;
  readonly protectedObjectId: string;
  readonly send: JobSender;
  readonly logger: Logger;
  readonly jobIdGenerator?: () => string;
}): Promise<string | null> {
  const { store, tenantId, protectedObjectId, send, logger } = options;
  const backupJobId = await store.verifyBackupJobId(protectedObjectId);
  const scheduleId = backupJobId === null ? await store.verifyScheduleId(protectedObjectId) : null;
  if (backupJobId === null && scheduleId === null) {
    return null;
  }
  const payload: VerifyJobPayload = {
    jobId: (options.jobIdGenerator ?? randomUUID)(),
    tenantId,
    protectedObjectId,
    kind: "verify",
    sampleSize: DEFAULT_VERIFY_SAMPLE_SIZE,
    // The job (or the schedule an older release made) that asked for checks, so its "last run"
    // shows this one; `afterBackup` tells it apart from a run it fired itself.
    ...(backupJobId !== null ? { backupJobId } : {}),
    ...(scheduleId !== null ? { scheduleId } : {}),
    afterBackup: true,
  };
  const singletonKey = singletonKeyFor("verify", payload);
  const pgBossJobId = await send("verify", payload, {
    priority: JOB_PRIORITY.verify,
    ...(singletonKey ? { singletonKey } : {}),
  });
  if (pgBossJobId === null) {
    logger.info("verify already queued for this object, not enqueuing another");
    return null;
  }
  await store.insertQueuedJob({
    jobId: payload.jobId,
    queue: "verify",
    protectedObjectId,
    payload: payload as unknown as Record<string, unknown>,
    pgBossJobId,
  });
  logger.info("verify enqueued after backup", { verifyJobId: payload.jobId });
  return payload.jobId;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface BackupHandlerOptions {
  readonly engines: BackupEngineRegistry;
  /** Override the persistence seam (tests); defaults to Postgres through the job's tenant. */
  readonly store?: (ctx: WorkerJobContext) => BackupStore;
  /** Override the pg-boss sender (tests); defaults to the worker's pool. */
  readonly send?: JobSender;
}

export function createBackupHandler(options: BackupHandlerOptions): JobHandler<"backup"> {
  const { engines } = options;

  return {
    queue: "backup",

    async run(ctx: WorkerJobContext, payload: BackupJobPayload): Promise<JobOutcome> {
      const object = ctx.protectedObject;
      if (!object) {
        throw new InvalidPayloadError("backup job payload names no protected object");
      }
      const store = options.store
        ? options.store(ctx)
        : pgBackupStore(tenantRunner(ctx.db, ctx.tenantId), ctx.tenantId, ctx.keys);
      const send: JobSender =
        options.send ??
        ((queue, verifyPayload, sendOptions) =>
          bossFor(ctx.db).send(queue, verifyPayload, sendOptions));
      const logger = ctx.logger.child({ protectedObjectId: object.id, kind: object.kind });

      const { source, objectStatus, objectStatusReason, objectSecretRef } =
        await store.loadSource(object);
      const eligibility: EligibilityInput = {
        objectKind: object.kind,
        objectStatus,
        objectStatusReason: objectStatusReason ?? null,
        sourceKind: source.kind,
        sourceStatus: source.status,
      };
      const rejection = backupRejection(eligibility);
      if (rejection) {
        const code = backupRejectionCode(eligibility);
        throw new InvalidPayloadError(
          `backup skipped: ${rejection}`,
          code === "config.object_inactive"
            ? buildCause(code, { reason: objectStatusReason ?? "no_license" })
            : code
              ? buildCause(code)
              : undefined,
        );
      }
      const factory = selectBackupEngine(engines, object.kind);

      const recorder = new PhaseRecorder(
        ctx.progress,
        (state) => store.persistRuntimeState(ctx.jobId, state),
        logger,
        ctx.now,
      );
      const deps: BackupEngineDeps = {
        ctx,
        source,
        store,
        objectSecretRef,
        throttled: (info) => recorder.throttled(info),
      };
      if (objectStatus === "orphaned" && objectStatusReason === "login_refused") {
        await probeLoginRefused({ deps, probe: engines.loginProbe, object, store, logger });
      }
      const engine = factory(deps);
      recorder.phase("starting");
      const full = payload.full === true;
      logger.info("backup starting", { full, attempt: ctx.attempt, sourceId: source.id });

      let result: BackupResult;
      try {
        result = await engine.run({ ...ctx, progress: recorder }, object, { full });
      } catch (error) {
        // A disabled or unlicensed account is no failed backup (core failures/limits.ts).
        // A lock nobody confirmed stays a counted failure, a cancelled run included.
        const inactive = ctx.signal.aborted
          ? unconfirmedLockFailure(error)
          : await confirmInactiveAfterFailure({
              error,
              object,
              check: engines.inactiveCheck,
              lockCheck: engines.lockCheck,
              deps,
              store,
              logger,
            });
        if (!inactive && !ctx.signal.aborted) {
          await countRefusedLogin({ error, object, store, logger });
        }
        throw inactive ?? error;
      } finally {
        // Whatever happened, the phase and any throttle wait must not outlive the run.
        await recorder.finish();
      }
      if (object.kind === "imap") {
        // The login worked: a streak of refused logins, and its question, are over.
        try {
          await store.recordLoginSuccess?.(object.id);
        } catch (error) {
          logger.warn("could not record the successful login", {
            errorMessage: safeErrorMessage(error),
          });
        }
      }

      // Engines report item failures as they go; one that only returns them
      // still gets them into item_failures for the UI.
      if (ctx.progress.snapshot().failed === 0) {
        for (const failure of result.failures) {
          ctx.progress.fail(failure.itemRef, failure.reason, failure.cause);
        }
      }

      const snapshot = await ctx.snapshots.get(result.snapshotId);
      if (!snapshot || snapshot.manifestPath === null) {
        throw new Error(
          `backup engine returned snapshot ${result.snapshotId} without a committed manifest`,
        );
      }
      const repairedCopies = await ensureManifestOnCopies(
        ctx.storage,
        snapshot.manifestPath,
        logger,
      );
      const verifyJobId = await enqueueVerifyAfterBackup({
        store,
        tenantId: ctx.tenantId,
        protectedObjectId: object.id,
        send,
        logger,
      });

      const stored = toStoredBackupResult({
        result,
        repairedCopies,
        verifyJobId,
        throttle: recorder.throttleTotals(),
        completedAt: ctx.now(),
      });
      await store.persistResult(ctx.jobId, stored);
      // File names of the activity report stay out of the log.
      const { activity: _activity, ...logged } = stored;
      logger.info("backup finished", { ...logged });
      return { summary: { ...stored } };
    },
  };
}

/** The engines the process uses; the entrypoint may register replacements. */
export const backupEngines = createDefaultBackupEngines();

export const backupHandler = createBackupHandler({ engines: backupEngines });
