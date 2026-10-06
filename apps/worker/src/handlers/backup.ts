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
  type AppCredentials,
  type BackupEngine,
  type BackupJobPayload,
  type BackupResult,
  ClientCredentialsTokenProvider,
  ExchangeBackupEngine,
  type FailureCause,
  type FailureCode,
  FetchGraphClient,
  type GraphClient,
  type ImapAccountConfig,
  ImapBackupEngine,
  JOB_PRIORITY,
  type Logger,
  OneDriveBackupEngine,
  type ProgressReporter,
  type ProgressSnapshot,
  type ProtectedObjectKind,
  type ProtectedObjectRef,
  type StorageTargets,
  type TenantKeyring,
  type ThrottleInfo,
  type VerifyJobPayload,
  appCredentialsFingerprint,
  buildCause,
  encryptChunk,
  entraAppCredentialsOf,
  parseSourceAppSecret,
  singletonKeyFor,
  toTokenCallback,
} from "@restow/core";
import {
  type Database,
  type Source,
  backupJobMembers,
  backupJobs,
  jobs,
  protectedObjects,
  safeErrorMessage,
  schedules,
  secrets,
  sources,
} from "@restow/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import PgBoss from "pg-boss";
import { type EntraAppLookup, processEntraApp } from "../entra-app.js";
import type { TenantTxRunner } from "../progress.js";
import {
  InvalidPayloadError,
  type JobHandler,
  type JobOutcome,
  type WorkerJobContext,
  secretAad,
  tenantRunner,
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
};

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EligibilityInput {
  readonly objectKind: ProtectedObjectKind;
  readonly objectStatus: "active" | "excluded" | "orphaned";
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
  if (input.objectStatus === "orphaned") {
    return "config.object_orphaned";
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

  advance(done?: number, bytes?: number): void {
    this.inner.advance(done, bytes);
  }

  fail(itemRef: string, reason: string, cause?: FailureCause): void {
    this.inner.fail(itemRef, reason, cause);
  }

  phase(name: string): void {
    this.inner.phase(name);
    if (name === this.state.phase) {
      return;
    }
    this.record({ ...this.state, phase: name, phaseSince: this.now().toISOString() });
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
    failures: result.failures.length,
    repairedCopies: input.repairedCopies,
    verifyJobId: input.verifyJobId,
    throttleWaits: input.throttle.waits,
    throttleWaitMs: input.throttle.totalWaitMs,
    completedAt: input.completedAt.toISOString(),
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

/** Engine factories by protected-object kind. Registering a kind twice replaces it. */
export class BackupEngineRegistry {
  private readonly factories = new Map<ProtectedObjectKind, BackupEngineFactory>();

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
    onThrottle: deps.throttled,
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

export interface DefaultEngineOptions {
  readonly env?: Env;
  readonly entraApp?: EntraAppLookup;
  readonly tokens?: TokenProviderCache;
}

/** The engines this build ships: Exchange mailboxes, OneDrive and IMAP accounts. */
export function createDefaultBackupEngines(
  options: DefaultEngineOptions = {},
): BackupEngineRegistry {
  const settings: GraphSettings = {
    env: options.env ?? process.env,
    entraApp: options.entraApp ?? processEntraApp,
    tokens: options.tokens ?? new TokenProviderCache(),
  };
  return new BackupEngineRegistry([
    ["mailbox", (deps) => new ExchangeBackupEngine({ graph: lazyGraphClient(deps, settings) })],
    [
      "onedrive",
      (deps) => new OneDriveBackupEngine<Database>({ graph: lazyGraphClient(deps, settings) }),
    ],
    [
      "imap",
      (deps) =>
        new ImapBackupEngine({
          resolveAccount: async (_ctx, object) =>
            imapAccountFor(deps.source, object, deps.objectSecretRef, settings.env),
          allowInsecure: settings.env.IMAP_ALLOW_INSECURE?.trim().toLowerCase() === "true",
          onRefreshTokenRotated: (secretId, secretJson) =>
            deps.store.replaceSecret(secretId, secretJson),
        }),
    ],
  ]);
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

      const { source, objectStatus, objectSecretRef } = await store.loadSource(object);
      const eligibility: EligibilityInput = {
        objectKind: object.kind,
        objectStatus,
        sourceKind: source.kind,
        sourceStatus: source.status,
      };
      const rejection = backupRejection(eligibility);
      if (rejection) {
        const code = backupRejectionCode(eligibility);
        throw new InvalidPayloadError(
          `backup skipped: ${rejection}`,
          code ? buildCause(code) : undefined,
        );
      }
      const factory = selectBackupEngine(engines, object.kind);

      const recorder = new PhaseRecorder(
        ctx.progress,
        (state) => store.persistRuntimeState(ctx.jobId, state),
        logger,
        ctx.now,
      );
      const engine = factory({
        ctx,
        source,
        store,
        objectSecretRef,
        throttled: (info) => recorder.throttled(info),
      });
      recorder.phase("starting");
      const full = payload.full === true;
      logger.info("backup starting", { full, attempt: ctx.attempt, sourceId: source.id });

      let result: BackupResult;
      try {
        result = await engine.run({ ...ctx, progress: recorder }, object, { full });
      } finally {
        // Whatever happened, the phase and any throttle wait must not outlive the run.
        await recorder.finish();
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
      logger.info("backup finished", { ...stored });
      return { summary: { ...stored } };
    },
  };
}

/** The engines the process uses; the entrypoint may register replacements. */
export const backupEngines = createDefaultBackupEngines();

export const backupHandler = createBackupHandler({ engines: backupEngines });
