import { randomUUID } from "node:crypto";
import {
  type CopyCompleteness,
  type ExclusiveObjectsCheck,
  type InstallationDefaultStorage,
  type ObjectLockCapability,
  type OpenedStorageTarget,
  type StorageBackend,
  type StorageConfigIssue,
  type StorageLocation,
  type StorageMigrationJobPayload,
  type StorageProbeResult,
  StorageTargetError,
  checkCopyCompleteness,
  checkSourceExclusiveObjects,
  classifyStorageError,
  describeStorageError,
  describeStorageLocation,
  endpointPrefix,
  installationDefaultStorage,
  keyPrefix,
  manifestPrefix,
  openInstallationDefault,
  openStorageLocation,
  openStorageTarget,
  packPrefix,
  parseS3CredentialsSecret,
  serializeS3CredentialsSecret,
  storageLocationConfig,
  storageProbePrefix,
  validateStorageLocation,
  wrappedKeyKey,
} from "@restow/core";
import {
  type Database,
  type Job,
  type StorageMigration,
  type StorageTarget,
  endpoints,
  jobProgress,
  jobs as jobsTable,
  packs,
  snapshots,
  storageMigrations,
  storageTargets,
  tenantKeys,
} from "@restow/db";
import { productName } from "@restow/i18n";
import { type SQL, and, asc, count, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { snapshotNotImported } from "../../lib/imported-objects.js";
import { currentInstallationDefault } from "../../lib/installation-default.js";
import { deleteSecret, readSecret, replaceSecret, storeSecret } from "../../lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { parseOrProblem } from "../../schemas.js";
import { cancelQueuedJob, sendJob } from "../jobs/queue.js";
import {
  type InstallationDefaultDto,
  type StorageMigrationDto,
  type StorageTargetDto,
  type StorageTargetListDto,
  type TargetConfigRecords,
  accessKeyIdHint,
  compareTargets,
  locationOf,
  recordsOf,
  toInstallationDefaultDto,
  toMigrationDto,
  toTargetDto,
  withStalledJob,
} from "./dto.js";
import {
  type EndpointPolicyViolation,
  type HostResolver,
  checkTenantEndpoint,
} from "./endpoint-policy.js";
import {
  type StorageRuleViolation,
  type StorageSituation,
  canManageKind,
  credentialsBoundElsewhere,
  decideCreate,
  decideDelete,
  decidePromote,
  decideReplacePrimary,
  decideUpdate,
  movesLocation,
} from "./rules.js";
import {
  type CreateStorageTargetInput,
  type ProbeStorageInput,
  type S3CredentialsInput,
  type StorageMigrationModeInput,
  type UpdateStorageTargetInput,
  configSchemaFor,
} from "./schemas.js";
import { type DailyBytes, SERIES_DAYS, type UsageDto, buildUsage, windowStart } from "./usage.js";

/** `storage_migrations.status` values a migration is still in flight under. */
export const UNFINISHED_MIGRATION_STATUSES: readonly StorageMigration["status"][] = [
  "queued",
  "copying",
  "verifying",
  "switching",
];

/**
 * Statuses an admin may cancel from. Once the worker starts the atomic
 * switch it commits within moments (apps/worker/src/handlers/
 * storage-migration.ts); flagging `jobs.status` cancelled at that point would
 * not stop it, only leave a `storage.migration.cancelled` audit entry next to
 * one that says it switched. `dto.ts`'s `CANCELLABLE_STATUSES` matches this,
 * so the UI hides the cancel button by the same moment.
 */
const CANCELLABLE_MIGRATION_STATUSES: readonly StorageMigration["status"][] = [
  "queued",
  "copying",
  "verifying",
];

/** `jobs.status` values that mean the job backing a migration is still going. */
const LIVE_JOB_STATUSES: readonly Job["status"][] = ["queued", "active"];

/**
 * Storage targets of a tenant: where its chunk store lives (primary), where it
 * is copied to (copies), whether each target works (probe) and can enforce
 * WORM (Object Lock), and how much the tenant stores.
 *
 * Probes and listings talk to real storage, so they never run inside a
 * database transaction: rows are read, the storage is asked, the outcome is
 * written back. Every change and every check is audited; credentials are only
 * ever handed to the encrypted secret store.
 */

export const STORAGE_AUDIT_ACTIONS = {
  created: "storage.target.created",
  updated: "storage.target.updated",
  deleted: "storage.target.deleted",
  tested: "storage.target.tested",
  probed: "storage.target.probed",
  promoted: "storage.target.promoted",
  defaultTested: "storage.default.tested",
  /**
   * Migration lifecycle. `migrationStarted` covers both the `move` job being
   * queued and the `keep` variant's instant, synchronous switch (its details
   * carry `instant: true`); the rest are only ever `move`, written by the
   * worker handler (apps/worker/src/handlers/storage-migration.ts, which
   * duplicates these four strings verbatim — keep them in lock-step).
   */
  migrationStarted: "storage.migration.started",
  migrationVerifyFailed: "storage.migration.verify_failed",
  migrationSwitched: "storage.migration.switched",
  migrationCancelled: "storage.migration.cancelled",
} as const;

/** Plaintext S3 key pair (the `s3_credentials` secret). */
type S3Credentials = ReturnType<typeof parseS3CredentialsSecret>;

/** Read access to the tenant's secret store, as the core factory expects it. */
interface TenantSecretReader {
  get(secretId: string): Promise<string | null>;
}

/** Who acts, for the rules and the audit log. */
export interface Actor {
  id: string;
  email: string;
  ip: string | null;
  isProviderAdmin: boolean;
}

/** Collaborators that tests and other deployments may replace. */
export interface StorageDeps {
  /** DNS resolution for the tenant endpoint policy. */
  readonly resolveHost?: HostResolver;
  /** Environment for the installation default (tests); omitted = the current default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

export interface ProbeOutcomeDto {
  probe: StorageProbeResult;
  /** Detected when the probe succeeded against S3; a filesystem is always `unsupported`. */
  objectLock: ObjectLockCapability | null;
}

export interface TestResultDto extends ProbeOutcomeDto {
  target: StorageTargetDto;
}

export interface PromoteResultDto {
  target: StorageTargetDto;
  /** The target that was primary before (now a copy), or null when it was the installation default. */
  previousPrimaryId: string | null;
  completeness: CopyCompleteness;
}

export interface CompletenessDto {
  target: StorageTargetDto;
  completeness: CopyCompleteness;
}

// --- Problems -------------------------------------------------------------------

const PROBLEM_PREFIX = "urn:restow:problem:storage-";

function kebab(value: string): string {
  return value.replace(/_/g, "-");
}

const RULE_PROBLEMS: Record<
  StorageRuleViolation,
  { status: 403 | 409; title: string; detail: string }
> = {
  local_requires_provider_admin: {
    status: 403,
    title: "Provider admin required",
    detail: "Local targets are paths on the server; only a provider admin may manage them.",
  },
  primary_exists: {
    status: 409,
    title: "Primary target exists",
    detail: "This tenant already has a primary target. Add a copy and promote it instead.",
  },
  tenant_has_data: {
    status: 409,
    title: "Tenant already holds data",
    detail:
      "The tenant's data lives on the installation default. Add the new target as a copy, let it be mirrored, then promote it.",
  },
  location_overlap: {
    status: 409,
    title: "Location already in use",
    detail: "The location is, contains or lies inside a location this tenant already uses.",
  },
  location_locked: {
    status: 409,
    title: "Primary location is fixed",
    detail:
      "The primary target holds data; its location cannot change. Add the new location as a copy and promote it.",
  },
  primary_holds_data: {
    status: 409,
    title: "Primary target holds data",
    detail: "Promote another target to primary before removing this one.",
  },
  already_primary: {
    status: 409,
    title: "Already primary",
    detail: "This target already is the primary target.",
  },
  not_verified: {
    status: 409,
    title: "Target not verified",
    detail: "Run a successful test of the target before promoting it.",
  },
  migration_in_progress: {
    status: 409,
    title: "Migration in progress",
    detail:
      "This tenant already has a storage migration running. Wait for it to finish or cancel it.",
  },
  not_a_copy: {
    status: 409,
    title: "Not a copy",
    detail: "Only a copy target can be promoted to primary.",
  },
};

function ruleProblem(violation: StorageRuleViolation): ProblemError {
  const problem = RULE_PROBLEMS[violation];
  return new ProblemError(problem.status, problem.title, {
    type: `${PROBLEM_PREFIX}${kebab(violation)}`,
    detail: problem.detail,
    extensions: { code: violation },
  });
}

/** A location that failed validation: 422 naming the fields, so the form can mark them. */
export function invalidLocationProblem(issues: readonly StorageConfigIssue[]): ProblemError {
  const first = issues[0];
  return new ProblemError(422, "Invalid storage location", {
    type: `${PROBLEM_PREFIX}invalid-location`,
    detail: "The storage location is not usable as entered.",
    extensions: {
      field: first?.field ?? null,
      reason: first?.reason ?? null,
      fields: issues.map((issue) => ({ field: issue.field, reason: issue.reason })),
    },
  });
}

function endpointProblem(violation: EndpointPolicyViolation): ProblemError {
  return new ProblemError(422, "Endpoint not allowed", {
    type: `${PROBLEM_PREFIX}endpoint-not-allowed`,
    detail:
      "Tenant administrators can only use public HTTPS endpoints. A provider admin can configure internal endpoints.",
    extensions: { field: "endpoint", reason: violation },
  });
}

function notFound(): ProblemError {
  return new ProblemError(404, "Storage target not found", {
    type: `${PROBLEM_PREFIX}target-not-found`,
  });
}

function migrationNotFound(): ProblemError {
  return new ProblemError(404, "Storage migration not found", {
    type: `${PROBLEM_PREFIX}migration-not-found`,
    detail: "This target has no storage migration to cancel.",
  });
}

function migrationNotCancellable(status: StorageMigration["status"]): ProblemError {
  return new ProblemError(409, "Migration not cancellable", {
    type: `${PROBLEM_PREFIX}migration-not-cancellable`,
    detail: `A ${status} migration cannot be cancelled.`,
    extensions: { status },
  });
}

function migrationNotRetryable(status: StorageMigration["status"]): ProblemError {
  return new ProblemError(409, "Migration not retryable", {
    type: `${PROBLEM_PREFIX}migration-not-retryable`,
    detail: `A ${status} migration cannot be retried. Only a failed move can be tried again.`,
    extensions: { status },
  });
}

/** A target a finished migration still references cannot be deleted while an unfinished one runs. */
function migrationBlocksDelete(): ProblemError {
  return new ProblemError(409, "Migration in progress", {
    type: `${PROBLEM_PREFIX}migration-in-progress`,
    detail:
      "This target is part of a storage migration that has not finished yet. Wait for it or cancel it first.",
    extensions: { code: "migration_in_progress" },
  });
}

function installationDefaultReadOnly(): ProblemError {
  return new ProblemError(422, "Retired installation default has no settings", {
    type: `${PROBLEM_PREFIX}installation-default-readonly`,
    detail:
      "This placeholder stands for a retired installation default and has no addressing of its own to change. Remove it once it is no longer needed.",
  });
}

function credentialsNotApplicable(): ProblemError {
  return new ProblemError(422, "Credentials not applicable", {
    type: `${PROBLEM_PREFIX}credentials-not-applicable`,
    detail: "Only S3 targets store credentials.",
    extensions: { field: "credentials", reason: "not_applicable" },
  });
}

function keepTargetUnreachable(outcome: ProbeOutcomeDto): ProblemError {
  return new ProblemError(422, "Target not reachable", {
    type: `${PROBLEM_PREFIX}keep-target-unreachable`,
    detail:
      'The new target could not be verified with a quick write/read/delete check, so it cannot become the primary immediately. Fix the location or credentials, or choose "move" instead.',
    extensions: { code: "keep_target_unreachable", probe: outcome.probe },
  });
}

function activeEndpoints(): ProblemError {
  return new ProblemError(409, "Machines are backing up here", {
    type: `${PROBLEM_PREFIX}active-endpoints`,
    detail: `Servers or clients back up to this tenant's primary storage target through the ${productName()} agent, and their repositories are not moved with a storage change yet. Revoke or uninstall them first; their existing backups stay readable from the old location, which has to stay attached.`,
    extensions: { code: "active_endpoints" },
  });
}

function keepBlockedByActiveJob(): ProblemError {
  return new ProblemError(409, "Storage jobs still running", {
    type: `${PROBLEM_PREFIX}keep-blocked-by-active-job`,
    detail:
      'A backup, archive, retention, scrub or storage migration job for this tenant is still queued or running. Wait for it to finish, then add the target with "keep" again.',
    extensions: { code: "keep_blocked_by_active_job" },
  });
}

function credentialsRequired(): ProblemError {
  return new ProblemError(422, "Credentials required", {
    type: `${PROBLEM_PREFIX}credentials-required`,
    detail:
      "Enter the access key pair. Stored credentials are only sent to the endpoint they were saved for.",
    extensions: { field: "credentials", reason: "required" },
  });
}

function openProblem(error: unknown): ProblemError {
  if (error instanceof StorageTargetError) {
    if (error.code === "invalid_config") {
      return new ProblemError(409, "Stored configuration invalid", {
        type: `${PROBLEM_PREFIX}config-invalid`,
        detail: "The stored configuration of this target is no longer valid. Edit the target.",
        extensions: {
          fields: error.issues.map((issue) => ({ field: issue.field, reason: issue.reason })),
        },
      });
    }
    return new ProblemError(409, "Stored credentials unusable", {
      type: `${PROBLEM_PREFIX}credentials-unusable`,
      detail: "The stored credentials of this target cannot be read. Enter them again.",
    });
  }
  throw error;
}

function defaultUnavailable(): ProblemError {
  return new ProblemError(503, "Installation default storage not configured", {
    type: `${PROBLEM_PREFIX}default-misconfigured`,
    detail:
      "The installation default storage is not usable: neither a default saved under Installation, Default storage nor the storage settings in the environment (STORAGE_TARGET, S3_*) can be used.",
  });
}

function previousHoldsExclusiveData(check: ExclusiveObjectsCheck): ProblemError {
  return new ProblemError(409, "Retired target still holds exclusive data", {
    type: `${PROBLEM_PREFIX}previous-holds-exclusive-data`,
    detail:
      'This location still holds packs no other target has. Removing it now would make the snapshots that need them unrestorable. Run a "move" replacement first to copy them onto the current primary, then remove this location.',
    extensions: {
      code: "previous_holds_exclusive_data",
      exclusiveKeys: check.exclusiveKeys,
      exclusiveKeysOmitted: check.exclusiveKeysOmitted,
    },
  });
}

function previousHoldsEndpointRepositories(keys: readonly string[]): ProblemError {
  return new ProblemError(409, "Retired target still holds machine backups", {
    type: `${PROBLEM_PREFIX}previous-holds-endpoint-repositories`,
    detail:
      "This location still holds the backups of a server or client that only it has. A storage change does not move those yet, and removing the location would make them unreachable. Keep it attached.",
    extensions: {
      code: "previous_holds_endpoint_repositories",
      repositories: keys.slice(0, 20),
      repositoriesOmitted: Math.max(0, keys.length - 20),
    },
  });
}

function copyIncomplete(completeness: CopyCompleteness): ProblemError {
  return new ProblemError(409, "Copy incomplete", {
    type: `${PROBLEM_PREFIX}copy-incomplete`,
    detail: "The copy does not yet hold everything the primary holds.",
    extensions: { code: "copy_incomplete", completeness },
  });
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth++) {
    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// --- Loading --------------------------------------------------------------------

async function loadTargets(tx: DbExecutor, tenantId: string): Promise<StorageTarget[]> {
  const rows = await tx
    .select()
    .from(storageTargets)
    .where(eq(storageTargets.tenantId, tenantId))
    .orderBy(asc(storageTargets.createdAt));
  return rows.sort(compareTargets);
}

async function loadTarget(tx: DbExecutor, tenantId: string, id: string): Promise<StorageTarget> {
  const [row] = await tx
    .select()
    .from(storageTargets)
    .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, id)))
    .limit(1);
  if (!row) {
    throw notFound();
  }
  return row;
}

/**
 * Whether the tenant has stored anything: a pack, or an endpoint repository
 * (`endpoints/<id>/` in the primary target, whether or not the machine is
 * still active; docs/AGENT.md). Either one pins the primary: its location
 * cannot change and it cannot be removed while it holds data.
 */
async function tenantHasData(tx: DbExecutor, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: packs.id })
    .from(packs)
    .where(eq(packs.tenantId, tenantId))
    .limit(1);
  if (row !== undefined) {
    return true;
  }
  const [repository] = await tx
    .select({ id: endpoints.id })
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), isNotNull(endpoints.repositorySecretId)))
    .limit(1);
  return repository !== undefined;
}

/**
 * Whether an agent still backs up to the tenant's primary: an active endpoint.
 * The storage migration copies `tenants/<id>/...` and not `endpoints/`, and
 * the agent, retention and the checks write to whatever the primary is, so a
 * change of the primary would leave every active endpoint with an empty
 * repository. A revoked endpoint is only read, and stays readable from the
 * old target, which a change keeps attached (`previous`, or a copy).
 */
async function hasActiveEndpoints(tx: DbExecutor, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: endpoints.id })
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.status, "active")))
    .limit(1);
  return row !== undefined;
}

async function assertNoActiveEndpoints(db: DbExecutor, tenantId: string): Promise<void> {
  if (await withTenantTx(db, tenantId, (tx) => hasActiveEndpoints(tx, tenantId))) {
    throw activeEndpoints();
  }
}

/**
 * Queues whose jobs write to, or delete from, a tenant's primary storage
 * target (docs/STORAGE.md, "Replace the primary"). `restore` is here for its
 * download engine's ZIP export (core `restore/download.ts`), which writes the
 * archive to the primary; granular and full-mailbox restore on the same
 * queue never touch storage at all. `verify` and `directory` only read, so
 * they are not in this list.
 */
export const STORAGE_WRITING_QUEUES = [
  "backup",
  "archive",
  "retention",
  "scrub",
  "storage_migration",
  "restore",
  // Imports write chunks and manifests, exports write their file (docs/IMPORT.md).
  "import",
  "export",
] as const;

/**
 * Whether the tenant has a queued or active job on a queue that writes to
 * storage. A "keep" switch (`startReplacePrimaryTx`) refuses while one
 * exists: such a job may already hold the primary that is about to become
 * the read-only "previous" target in memory, or be seconds from resolving
 * it, and would keep writing to it after the switch — packs an already-
 * running backup writes there after the cutover are missed by
 * `LegacyExcludingPackCatalog` and get reported as damaged by the next
 * scrub, and a download archive an already-running restore writes there
 * would land on a target nothing may write to any more. This closes the
 * window from the API side; the worker closes the rest of it — a job that
 * starts after the switch on a storage cache that has not yet noticed it
 * (apps/worker/src/handlers/framework.ts, `resolveStorageForJob`).
 */
async function hasActiveWriteJob(tx: DbExecutor, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.tenantId, tenantId),
        inArray(jobsTable.queue, STORAGE_WRITING_QUEUES),
        inArray(jobsTable.status, ["queued", "active"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// --- Migrations -------------------------------------------------------------------

async function loadMigrations(tx: DbExecutor, tenantId: string): Promise<StorageMigration[]> {
  return tx
    .select()
    .from(storageMigrations)
    .where(eq(storageMigrations.tenantId, tenantId))
    .orderBy(desc(storageMigrations.createdAt));
}

function activeMigrationOf(rows: readonly StorageMigration[]): StorageMigration | null {
  return rows.find((row) => UNFINISHED_MIGRATION_STATUSES.includes(row.status)) ?? null;
}

/** `job_progress.eta_seconds` for the jobs backing `migrations`, keyed by `jobs.id`. */
async function migrationEtaSeconds(
  tx: DbExecutor,
  tenantId: string,
  migrations: readonly StorageMigration[],
): Promise<Map<string, number | null>> {
  const jobIds = migrations.flatMap((row) => (row.jobId ? [row.jobId] : []));
  if (jobIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ jobId: jobProgress.jobId, etaSeconds: jobProgress.etaSeconds })
    .from(jobProgress)
    .where(and(eq(jobProgress.tenantId, tenantId), inArray(jobProgress.jobId, jobIds)));
  return new Map(rows.map((row) => [row.jobId, row.etaSeconds]));
}

/** `jobs.status`/`errorMessage` for the jobs backing `migrations`, keyed by `jobs.id`. */
async function migrationJobStatuses(
  tx: DbExecutor,
  tenantId: string,
  migrations: readonly StorageMigration[],
): Promise<Map<string, { readonly status: Job["status"]; readonly errorMessage: string | null }>> {
  const jobIds = migrations.flatMap((row) => (row.jobId ? [row.jobId] : []));
  if (jobIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: jobsTable.id, status: jobsTable.status, errorMessage: jobsTable.errorMessage })
    .from(jobsTable)
    .where(and(eq(jobsTable.tenantId, tenantId), inArray(jobsTable.id, jobIds)));
  return new Map(
    rows.map((row) => [row.id, { status: row.status, errorMessage: row.errorMessage }]),
  );
}

/** `jobs.status` values after which nothing about that job runs again. */
const TERMINAL_JOB_STATUSES: readonly Job["status"][] = ["completed", "failed", "cancelled"];

/**
 * Whether `row` is stalled (see {@link StorageMigrationDto.stalled}): its own
 * status still reads as in flight, but the job behind it already ended for
 * good or is missing, so nothing is copying or verifying any more even
 * though the row itself has not been reconciled. A `keep` migration is
 * never stalled (it switches synchronously and has no job); a fresh `move`
 * always has a `jobId` set in the same transaction that queues it
 * (`startReplacePrimaryTx`), so a missing job row here means it vanished,
 * not that it has not been created yet.
 */
function stalledStateOf(
  row: StorageMigration,
  jobStatuses: ReadonlyMap<
    string,
    { readonly status: Job["status"]; readonly errorMessage: string | null }
  >,
): { readonly stalled: boolean; readonly errorMessage: string | null } {
  if (!UNFINISHED_MIGRATION_STATUSES.includes(row.status) || !row.jobId) {
    return { stalled: false, errorMessage: null };
  }
  const job = jobStatuses.get(row.jobId);
  if (!job || TERMINAL_JOB_STATUSES.includes(job.status)) {
    return { stalled: true, errorMessage: job?.errorMessage ?? null };
  }
  return { stalled: false, errorMessage: null };
}

/**
 * The most relevant migration of each target, as its source or its
 * destination: the active one if any, else the most recently created
 * (`migrations` is already newest-first). A target is at most one side of at
 * most one migration in practice (a finished one is cleared when its target
 * is deleted, see {@link deleteTarget}), but this stays correct even if
 * history briefly disagrees.
 */
function migrationsByTargetId(
  migrations: readonly StorageMigration[],
  etaByJobId: ReadonlyMap<string, number | null>,
  jobStatuses: ReadonlyMap<
    string,
    { readonly status: Job["status"]; readonly errorMessage: string | null }
  >,
): Map<string, StorageMigrationDto> {
  const byTarget = new Map<string, StorageMigrationDto>();
  const rank = (status: StorageMigration["status"]) =>
    UNFINISHED_MIGRATION_STATUSES.includes(status) ? 1 : 0;
  const consider = (
    targetId: string | null,
    role: "source" | "destination",
    row: StorageMigration,
  ) => {
    if (!targetId) {
      return;
    }
    const eta = row.jobId ? (etaByJobId.get(row.jobId) ?? null) : null;
    const existing = byTarget.get(targetId);
    if (!existing || rank(row.status) > rank(existing.status)) {
      const dto = toMigrationDto(row, role, eta);
      const { stalled, errorMessage } = stalledStateOf(row, jobStatuses);
      byTarget.set(targetId, stalled ? withStalledJob(dto, errorMessage) : dto);
    }
  };
  for (const row of migrations) {
    consider(row.sourceTargetId, "source", row);
    consider(row.destinationTargetId, "destination", row);
  }
  return byTarget;
}

/**
 * The installation default that applies right now (the one saved under
 * Installation → Default storage, else the environment;
 * lib/installation-default.ts), or null when it is not usable. `deps.env`
 * (tests) reads that environment alone.
 */
async function readInstallationDefault(
  deps: StorageDeps,
): Promise<InstallationDefaultStorage | null> {
  if (!deps.env) {
    return currentInstallationDefault();
  }
  try {
    return installationDefaultStorage(deps.env);
  } catch (error) {
    if (error instanceof StorageTargetError) {
      return null;
    }
    throw error;
  }
}

/** Everything the rules need, from rows already loaded in the caller's transaction. */
function situationOf(
  rows: readonly StorageTarget[],
  hasData: boolean,
  defaults: InstallationDefaultStorage | null,
  actor: Actor,
  excludeId?: string,
): StorageSituation {
  const hasPrimaryTarget = rows.some((row) => row.role === "primary");
  const locationsInUse: StorageLocation[] = [];
  for (const row of rows) {
    const location = row.id === excludeId ? null : locationOf(row);
    if (location) {
      locationsInUse.push(location);
    }
  }
  if (!hasPrimaryTarget && defaults) {
    locationsInUse.push(defaults.primary);
    if (defaults.copy) {
      locationsInUse.push(defaults.copy);
    }
  }
  return {
    isProviderAdmin: actor.isProviderAdmin,
    tenantHasData: hasData,
    hasPrimaryTarget,
    locationsInUse,
  };
}

/** Secrets of the tenant, opened on demand (each read in its own tenant-pinned transaction). */
function secretReaderFor(db: DbExecutor, tenantId: string): TenantSecretReader {
  return { get: (secretId) => readSecret(db, { id: secretId, tenantId }) };
}

function validLocation(kind: StorageLocation["kind"], config: unknown): StorageLocation {
  const validation = validateStorageLocation(kind, config);
  if (!validation.ok) {
    throw invalidLocationProblem(validation.issues);
  }
  return validation.location;
}

/** Tenant admins may only reach public HTTPS endpoints (see endpoint-policy.ts). */
async function enforceEndpointPolicy(
  location: StorageLocation,
  actor: Actor,
  deps: StorageDeps,
): Promise<void> {
  if (actor.isProviderAdmin || location.kind !== "s3" || location.endpoint === null) {
    return;
  }
  const violation = await checkTenantEndpoint(location.endpoint, deps.resolveHost);
  if (violation) {
    throw endpointProblem(violation);
  }
}

function toCredentials(input: S3CredentialsInput): S3Credentials {
  return { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey };
}

/** The config column for a location plus this feature's records. */
function configFor(
  location: StorageLocation,
  records: TargetConfigRecords,
): Record<string, unknown> {
  return { ...storageLocationConfig(location), ...records };
}

/** Merge this feature's records into `config` in one statement (the addressing stays as is). */
function mergeRecords(records: TargetConfigRecords): SQL {
  return sql`coalesce(${storageTargets.config}, '{}'::jsonb) || ${JSON.stringify(records)}::jsonb`;
}

// --- Queries --------------------------------------------------------------------

export async function listTargets(
  db: Database,
  tenantId: string,
  actor: Pick<Actor, "isProviderAdmin">,
  deps: StorageDeps = {},
): Promise<StorageTargetListDto> {
  const { rows, hasData, migrationsByTarget } = await withTenantTx(db, tenantId, async (tx) => {
    const migrations = await loadMigrations(tx, tenantId);
    const [eta, jobStatuses] = await Promise.all([
      migrationEtaSeconds(tx, tenantId, migrations),
      migrationJobStatuses(tx, tenantId, migrations),
    ]);
    return {
      rows: await loadTargets(tx, tenantId),
      hasData: await tenantHasData(tx, tenantId),
      migrationsByTarget: migrationsByTargetId(migrations, eta, jobStatuses),
    };
  });
  const defaults = await readInstallationDefault(deps);
  const inUse = !rows.some((row) => row.role === "primary");
  return {
    items: rows.map((row) => toTargetDto(row, actor, migrationsByTarget.get(row.id) ?? null)),
    installationDefault: toInstallationDefaultDto(defaults, inUse, actor),
    tenantHasData: hasData,
    canManageLocal: actor.isProviderAdmin,
  };
}

export async function getTarget(
  db: Database,
  tenantId: string,
  id: string,
  actor: Pick<Actor, "isProviderAdmin">,
): Promise<StorageTargetDto> {
  const { row, migration } = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadTarget(tx, tenantId, id);
    const migrations = await loadMigrations(tx, tenantId);
    const [eta, jobStatuses] = await Promise.all([
      migrationEtaSeconds(tx, tenantId, migrations),
      migrationJobStatuses(tx, tenantId, migrations),
    ]);
    return { row, migration: migrationsByTargetId(migrations, eta, jobStatuses).get(id) ?? null };
  });
  return toTargetDto(row, actor, migration);
}

// --- Changes --------------------------------------------------------------------

export async function createTarget(
  db: Database,
  tenantId: string,
  input: CreateStorageTargetInput,
  actor: Actor,
  deps: StorageDeps = {},
): Promise<StorageTargetDto> {
  const location = validLocation(input.kind, input.config);
  if (!actor.isProviderAdmin && location.kind === "local") {
    throw ruleProblem("local_requires_provider_admin");
  }
  await enforceEndpointPolicy(location, actor, deps);
  const defaults = await readInstallationDefault(deps);

  if (input.role === "primary" && input.migrationMode) {
    const replacesExisting = await withTenantTx(db, tenantId, async (tx) => {
      const rows = await loadTargets(tx, tenantId);
      return rows.some((row) => row.role === "primary") || (await tenantHasData(tx, tenantId));
    });
    // Nothing to replace yet (a fresh tenant): `migrationMode` was sent
    // ahead of time by a UI that does not know that yet either. Fall through
    // to the ordinary direct-create path below, exactly as without it.
    if (replacesExisting) {
      return startReplacePrimary(db, tenantId, input, location, actor, deps);
    }
  }

  try {
    const row = await withTenantTx(db, tenantId, async (tx) => {
      const rows = await loadTargets(tx, tenantId);
      const situation = situationOf(rows, await tenantHasData(tx, tenantId), defaults, actor);
      const violation = decideCreate(situation, { role: input.role, location });
      if (violation) {
        throw ruleProblem(violation);
      }
      let secretRef: string | null = null;
      const records: TargetConfigRecords = {};
      if (input.kind === "s3") {
        const secret = await storeSecret(tx, {
          tenantId,
          kind: "s3_credentials",
          plaintext: serializeS3CredentialsSecret(toCredentials(input.credentials)),
        });
        secretRef = secret.id;
        records.accessKeyIdHint = accessKeyIdHint(input.credentials.accessKeyId);
      }
      const [inserted] = await tx
        .insert(storageTargets)
        .values({
          tenantId,
          name: input.name,
          kind: input.kind,
          role: input.role,
          config: configFor(location, records) as StorageTarget["config"],
          secretRef,
        })
        .returning();
      if (!inserted) {
        throw new Error("storage target insert returned no row");
      }
      await audit(tx, {
        tenantId,
        actor: actor.email,
        actorUserId: actor.id,
        action: STORAGE_AUDIT_ACTIONS.created,
        target: inserted.id,
        targetType: "storage_target",
        ip: actor.ip,
        details: {
          name: input.name,
          kind: input.kind,
          role: input.role,
          location: describeStorageLocation(location),
        },
      });
      return inserted;
    });
    return toTargetDto(row, actor);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw ruleProblem("primary_exists");
    }
    throw error;
  }
}

/** The probe `startReplacePrimaryTx` requires before a "keep" switch (see its call site). */
async function verifyKeepTarget(
  tenantId: string,
  location: StorageLocation,
  input: CreateStorageTargetInput,
  now: () => Date,
): Promise<void> {
  const credentials = input.kind === "s3" ? toCredentials(input.credentials) : undefined;
  let opened: OpenedStorageTarget;
  try {
    opened = openStorageLocation(location, { credentials, purpose: "probe" });
  } catch (error) {
    throw openProblem(error);
  }
  const outcome = await runChecks(opened, tenantId, { requireExistingPath: false, now });
  if (!outcome.probe.ok) {
    throw keepTargetUnreachable(outcome);
  }
}

/**
 * Add a target and replace the tenant's current primary with it
 * (docs/STORAGE.md, "Replace the primary"). `keep` switches instantly, right
 * here, in one transaction: nothing is copied, the new target takes every
 * backup from now on, and the old one stays attached read-only. It refuses
 * (`keepBlockedByActiveJob`) while the tenant has a queued or active backup,
 * archive, retention, scrub or storage_migration job, so nothing already
 * running still writes to the target about to become read-only
 * (`hasActiveWriteJob`). `move` inserts the new target as a live copy (so it
 * already receives new backups) and queues the `storage_migration` job that
 * backfills everything older, verifies it by hash, and switches atomically
 * when that passes (apps/worker/src/handlers/storage-migration.ts).
 */
async function startReplacePrimary(
  db: Database,
  tenantId: string,
  input: CreateStorageTargetInput,
  location: StorageLocation,
  actor: Actor,
  deps: StorageDeps,
): Promise<StorageTargetDto> {
  const mode = input.migrationMode;
  if (mode === undefined) {
    // createTarget only calls this once input.migrationMode is set.
    throw new Error("startReplacePrimary requires migrationMode");
  }
  const defaults = await readInstallationDefault(deps);
  const now = deps.now ?? (() => new Date());

  try {
    return await startReplacePrimaryTx(
      db,
      tenantId,
      input,
      location,
      actor,
      deps,
      mode,
      defaults,
      now,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent request won the race: either another primary or another
      // unfinished migration exists now, both of which the rule check above
      // would have refused had it seen them — report the same 409 instead of
      // a raw constraint violation.
      throw ruleProblem("migration_in_progress");
    }
    throw error;
  }
}

async function startReplacePrimaryTx(
  db: Database,
  tenantId: string,
  input: CreateStorageTargetInput,
  location: StorageLocation,
  actor: Actor,
  deps: StorageDeps,
  mode: StorageMigrationModeInput,
  defaults: InstallationDefaultStorage | null,
  now: () => Date,
): Promise<StorageTargetDto> {
  // Refused before anything is probed or copied (and checked again in the
  // transaction below, where the switch is decided).
  await assertNoActiveEndpoints(db, tenantId);
  if (mode === "keep") {
    // "keep" switches the primary immediately, in the transaction below,
    // with no copy job to catch a bad location or stale credentials
    // afterwards ("move" has its own verify pass instead): prove the target
    // is actually reachable first, the same write/read/list/delete probe
    // `POST /targets/:id/test` runs.
    await verifyKeepTarget(tenantId, location, input, now);
  }
  const { destination, migration } = await withTenantTx(db, tenantId, async (tx) => {
    const rows = await loadTargets(tx, tenantId);
    const situation = situationOf(rows, await tenantHasData(tx, tenantId), defaults, actor);
    const existingMigrations = await loadMigrations(tx, tenantId);
    const violation = decideReplacePrimary(situation, {
      location,
      migrationInProgress: activeMigrationOf(existingMigrations) !== null,
    });
    if (violation) {
      throw ruleProblem(violation);
    }
    if (await hasActiveEndpoints(tx, tenantId)) {
      throw activeEndpoints();
    }
    if (mode === "keep" && (await hasActiveWriteJob(tx, tenantId))) {
      throw keepBlockedByActiveJob();
    }
    const currentPrimary = rows.find((row) => row.role === "primary") ?? null;

    let secretRef: string | null = null;
    const records: TargetConfigRecords = {};
    if (input.kind === "s3") {
      const secret = await storeSecret(tx, {
        tenantId,
        kind: "s3_credentials",
        plaintext: serializeS3CredentialsSecret(toCredentials(input.credentials)),
      });
      secretRef = secret.id;
      records.accessKeyIdHint = accessKeyIdHint(input.credentials.accessKeyId);
    }
    const config = configFor(location, records) as StorageTarget["config"];

    if (mode === "keep") {
      if (currentPrimary) {
        await tx
          .update(storageTargets)
          .set({ role: "previous" })
          .where(
            and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, currentPrimary.id)),
          );
      }
      const [inserted] = await tx
        .insert(storageTargets)
        .values({
          tenantId,
          name: input.name,
          kind: input.kind,
          role: "primary",
          config,
          secretRef,
        })
        .returning();
      if (!inserted) {
        throw new Error("storage target insert returned no row");
      }
      const sourceTargetId = currentPrimary
        ? currentPrimary.id
        : await insertRetiredInstallationDefault(tx, tenantId);
      const at = now();
      const [migrationRow] = await tx
        .insert(storageMigrations)
        .values({
          tenantId,
          sourceTargetId,
          destinationTargetId: inserted.id,
          mode: "keep",
          status: "completed",
          objectsTotal: 0,
          objectsDone: 0,
          startedAt: at,
          verifiedAt: at,
          switchedAt: at,
          finishedAt: at,
        })
        .returning();
      if (!migrationRow) {
        throw new Error("storage migration insert returned no row");
      }
      await audit(tx, {
        tenantId,
        actor: actor.email,
        actorUserId: actor.id,
        action: STORAGE_AUDIT_ACTIONS.migrationStarted,
        target: inserted.id,
        targetType: "storage_target",
        ip: actor.ip,
        details: {
          mode,
          instant: true,
          sourcePrimary: sourceTargetId,
          location: describeStorageLocation(location),
        },
      });
      return { destination: inserted, migration: migrationRow };
    }

    // mode === "move": the destination starts as a live copy so new backups
    // replicate to it immediately; the background job backfills the rest.
    const [inserted] = await tx
      .insert(storageTargets)
      .values({ tenantId, name: input.name, kind: input.kind, role: "copy", config, secretRef })
      .returning();
    if (!inserted) {
      throw new Error("storage target insert returned no row");
    }
    const [migrationRow] = await tx
      .insert(storageMigrations)
      .values({
        tenantId,
        sourceTargetId: currentPrimary?.id ?? null,
        destinationTargetId: inserted.id,
        mode: "move",
        status: "queued",
      })
      .returning();
    if (!migrationRow) {
      throw new Error("storage migration insert returned no row");
    }
    const payload: StorageMigrationJobPayload = {
      jobId: randomUUID(),
      tenantId,
      migrationId: migrationRow.id,
    };
    const pgBossJobId = await sendJob(tx, "storage_migration", payload, db);
    if (pgBossJobId === null) {
      // The singleton key is the fresh migration id, so this can only mean
      // pg-boss's schema is not ready yet (a fresh install before the worker
      // has started once). The migration row stays "queued"; nothing polls
      // it, so surface this instead of leaving the admin waiting forever.
      throw new ProblemError(503, "Job queue not ready", {
        type: `${PROBLEM_PREFIX}queue-not-ready`,
        detail: "The background job queue is not ready yet. Try again in a moment.",
      });
    }
    await tx.insert(jobsTable).values({
      id: payload.jobId,
      tenantId,
      queue: "storage_migration",
      status: "queued",
      payload: payload as unknown as Record<string, unknown>,
      pgBossJobId,
    });
    const [linked] = await tx
      .update(storageMigrations)
      .set({ jobId: payload.jobId })
      .where(
        and(eq(storageMigrations.tenantId, tenantId), eq(storageMigrations.id, migrationRow.id)),
      )
      .returning();
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: STORAGE_AUDIT_ACTIONS.migrationStarted,
      target: inserted.id,
      targetType: "storage_target",
      ip: actor.ip,
      details: {
        mode,
        sourcePrimary: currentPrimary?.id ?? "installation_default",
        location: describeStorageLocation(location),
        jobId: payload.jobId,
      },
    });
    return { destination: inserted, migration: linked ?? migrationRow };
  });
  return toTargetDto(destination, actor, toMigrationDto(migration, "destination", null));
}

/** A placeholder row standing for the environment default just retired (docs/STORAGE.md). */
async function insertRetiredInstallationDefault(tx: DbExecutor, tenantId: string): Promise<string> {
  const [placeholder] = await tx
    .insert(storageTargets)
    .values({
      tenantId,
      name: null,
      kind: "installation_default",
      role: "previous",
      config: {},
    })
    .returning({ id: storageTargets.id });
  if (!placeholder) {
    throw new Error("installation-default placeholder insert returned no row");
  }
  return placeholder.id;
}

/**
 * Cancel a storage migration that has not finished yet, or finalize one whose
 * job already ended without the migration row noticing.
 *
 * A queued job is withdrawn from pg-boss and the migration is finished right
 * here; a running one is flagged and the worker aborts it at its next
 * checkpoint, finishing the migration row itself once it notices (docs/
 * STORAGE.md). `switching` is not cancellable: the worker commits that atomic
 * step within moments, so flagging it now would not stop it, only leave a
 * "cancelled" audit entry next to one that says it switched.
 *
 * This is also how an admin recovers a migration whose job died for good
 * (an unreachable destination that exhausted its retries, a worker that
 * never came back): its `jobs` row is `failed`, `completed` or `cancelled`,
 * or gone, while `storage_migrations` is still `copying` or `verifying`
 * because nothing told it otherwise. This action notices that and finishes
 * the row to match, so the card stops reading "Migrating" forever and, for a
 * `move`, the operator can try again with a fresh job for the same
 * destination.
 */
export async function cancelMigration(
  db: Database,
  tenantId: string,
  destinationTargetId: string,
  actor: Actor,
): Promise<StorageMigrationDto> {
  const { migration, pgBossCancel } = await withTenantTx(db, tenantId, async (tx) => {
    const [migration] = await tx
      .select()
      .from(storageMigrations)
      .where(
        and(
          eq(storageMigrations.tenantId, tenantId),
          eq(storageMigrations.destinationTargetId, destinationTargetId),
        ),
      )
      .orderBy(desc(storageMigrations.createdAt))
      .limit(1);
    if (!migration) {
      throw migrationNotFound();
    }
    if (!UNFINISHED_MIGRATION_STATUSES.includes(migration.status)) {
      throw migrationNotCancellable(migration.status);
    }
    const jobRow = migration.jobId
      ? ((
          await tx
            .select({
              status: jobsTable.status,
              pgBossJobId: jobsTable.pgBossJobId,
              errorMessage: jobsTable.errorMessage,
            })
            .from(jobsTable)
            .where(and(eq(jobsTable.tenantId, tenantId), eq(jobsTable.id, migration.jobId)))
            .limit(1)
        )[0] ?? null)
      : null;
    const jobIsLive = jobRow !== null && LIVE_JOB_STATUSES.includes(jobRow.status);

    let pgBossCancel: string | null = null;
    let finished = migration;

    if (!jobIsLive) {
      // The job already ended for good (or there never was one) but the
      // migration itself was left open: finalize it now, mirroring what
      // actually happened rather than claiming this click stopped it.
      const resultStatus: StorageMigration["status"] =
        jobRow?.status === "cancelled" ? "cancelled" : "failed";
      const errorMessage =
        resultStatus === "failed"
          ? (jobRow?.errorMessage ?? "the background job for this migration is no longer running")
          : null;
      const [updated] = await tx
        .update(storageMigrations)
        .set({ status: resultStatus, errorMessage, finishedAt: new Date() })
        .where(
          and(eq(storageMigrations.tenantId, tenantId), eq(storageMigrations.id, migration.id)),
        )
        .returning();
      finished = updated ?? migration;
    } else if (!CANCELLABLE_MIGRATION_STATUSES.includes(migration.status)) {
      throw migrationNotCancellable(migration.status);
    } else if (jobRow.status === "queued") {
      await tx
        .update(jobsTable)
        .set({ status: "cancelled", completedAt: new Date(), cursor: null })
        .where(and(eq(jobsTable.tenantId, tenantId), eq(jobsTable.id, migration.jobId as string)));
      pgBossCancel = jobRow.pgBossJobId;
      // Nothing was ever running: finish the migration right away instead
      // of waiting for a worker that never picked it up to notice.
      const [updated] = await tx
        .update(storageMigrations)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(
          and(eq(storageMigrations.tenantId, tenantId), eq(storageMigrations.id, migration.id)),
        )
        .returning();
      finished = updated ?? migration;
    } else {
      await tx
        .update(jobsTable)
        .set({ status: "cancelled" })
        .where(and(eq(jobsTable.tenantId, tenantId), eq(jobsTable.id, migration.jobId as string)));
      // The worker's cancel poll finds this within its usual interval and
      // aborts the job; it finishes storage_migrations itself when it does
      // (apps/worker/src/handlers/storage-migration.ts), so the status here
      // stays as it was until then.
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: STORAGE_AUDIT_ACTIONS.migrationCancelled,
      target: destinationTargetId,
      targetType: "storage_target",
      ip: actor.ip,
      details: {
        migrationId: migration.id,
        previousStatus: migration.status,
        resultStatus: finished.status,
      },
    });
    return { migration: finished, pgBossCancel };
  });
  if (pgBossCancel) {
    // Best effort: the row already says cancelled either way.
    await cancelQueuedJob("storage_migration", pgBossCancel, db).catch(() => undefined);
  }
  return toMigrationDto(migration, "destination", null);
}

/**
 * Re-queue a failed `move` migration for the same destination, instead of
 * requiring delete-and-recreate (which `location_overlap` refuses anyway
 * while the destination row is still there). Resets progress; the fresh job
 * starts its copy pass from scratch, but every object already on the
 * destination is found present and verified quickly rather than rewritten.
 */
export async function retryMigration(
  db: Database,
  tenantId: string,
  destinationTargetId: string,
  actor: Actor,
): Promise<StorageMigrationDto> {
  const { migration } = await withTenantTx(db, tenantId, async (tx) => {
    const [migration] = await tx
      .select()
      .from(storageMigrations)
      .where(
        and(
          eq(storageMigrations.tenantId, tenantId),
          eq(storageMigrations.destinationTargetId, destinationTargetId),
        ),
      )
      .orderBy(desc(storageMigrations.createdAt))
      .limit(1);
    if (!migration) {
      throw migrationNotFound();
    }
    if (migration.mode !== "move" || migration.status !== "failed") {
      throw migrationNotRetryable(migration.status);
    }
    const [destinationRow] = await tx
      .select({ id: storageTargets.id, role: storageTargets.role })
      .from(storageTargets)
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, destinationTargetId)))
      .limit(1);
    if (!destinationRow || destinationRow.role !== "copy") {
      throw notFound();
    }
    const jobId = randomUUID();
    const payload: StorageMigrationJobPayload = { jobId, tenantId, migrationId: migration.id };
    const pgBossJobId = await sendJob(tx, "storage_migration", payload, db);
    if (pgBossJobId === null) {
      throw new ProblemError(503, "Job queue not ready", {
        type: `${PROBLEM_PREFIX}queue-not-ready`,
        detail: "The background job queue is not ready yet. Try again in a moment.",
      });
    }
    await tx.insert(jobsTable).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "queued",
      payload: payload as unknown as Record<string, unknown>,
      pgBossJobId,
    });
    const [updated] = await tx
      .update(storageMigrations)
      .set({
        status: "queued",
        jobId,
        errorMessage: null,
        finishedAt: null,
        startedAt: null,
        verifiedAt: null,
        objectsDone: 0,
        bytesDone: 0,
      })
      .where(and(eq(storageMigrations.tenantId, tenantId), eq(storageMigrations.id, migration.id)))
      .returning();
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: STORAGE_AUDIT_ACTIONS.migrationStarted,
      target: destinationTargetId,
      targetType: "storage_target",
      ip: actor.ip,
      details: {
        mode: "move",
        retry: true,
        sourcePrimary: migration.sourceTargetId ?? "installation_default",
        jobId,
      },
    });
    return { migration: updated ?? migration };
  });
  return toMigrationDto(migration, "destination", null);
}

export async function updateTarget(
  db: Database,
  tenantId: string,
  id: string,
  patch: UpdateStorageTargetInput,
  actor: Actor,
  deps: StorageDeps = {},
): Promise<StorageTargetDto> {
  const current = await withTenantTx(db, tenantId, (tx) => loadTarget(tx, tenantId, id));
  if (patch.credentials && current.kind !== "s3") {
    throw credentialsNotApplicable();
  }
  let next: StorageLocation | null = null;
  if (patch.config) {
    if (current.kind === "installation_default") {
      // The placeholder for a retired installation default has no addressing
      // of its own to edit (docs/STORAGE.md); only its name may change.
      throw installationDefaultReadOnly();
    }
    next = validLocation(current.kind, parseOrProblem(configSchemaFor(current.kind), patch.config));
  }
  if (next) {
    await enforceEndpointPolicy(next, actor, deps);
    if (!patch.credentials && credentialsBoundElsewhere(locationOf(current), next)) {
      throw credentialsRequired();
    }
  }
  const defaults = await readInstallationDefault(deps);

  const row = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadTarget(tx, tenantId, id);
    const currentLocation = locationOf(row);
    const rows = await loadTargets(tx, tenantId);
    const situation = situationOf(rows, await tenantHasData(tx, tenantId), defaults, actor, id);
    const migrationInProgress = activeMigrationOf(await loadMigrations(tx, tenantId)) !== null;
    // A row whose stored addressing no longer validates can always be repaired
    // (by whoever may manage its kind): there is no valid location to protect.
    const violation = currentLocation
      ? decideUpdate(situation, {
          role: row.role,
          current: currentLocation,
          next,
          migrationInProgress,
        })
      : canManageKind(row.kind, actor.isProviderAdmin)
        ? null
        : "local_requires_provider_admin";
    if (violation) {
      throw ruleProblem(violation);
    }

    const records = recordsOf(row);
    const changes: Partial<typeof storageTargets.$inferInsert> = {};
    const changed: string[] = [];
    let secretRef = row.secretRef;
    let hint = records.accessKeyIdHint ?? null;

    if (patch.name !== undefined && patch.name !== row.name) {
      changes.name = patch.name;
      changed.push("name");
    }
    if (patch.credentials) {
      const plaintext = serializeS3CredentialsSecret(toCredentials(patch.credentials));
      if (secretRef) {
        await replaceSecret(tx, { id: secretRef, tenantId }, plaintext);
      } else {
        secretRef = (await storeSecret(tx, { tenantId, kind: "s3_credentials", plaintext })).id;
        changes.secretRef = secretRef;
      }
      hint = accessKeyIdHint(patch.credentials.accessKeyId);
      changed.push("credentials");
    }
    const location = next ?? currentLocation;
    const addressingChanged =
      next !== null && (currentLocation === null || !sameAddressing(currentLocation, next));
    if (addressingChanged) {
      changed.push("config");
    }
    if (location && (addressingChanged || patch.credentials)) {
      // New addressing or credentials: what the last probe proved no longer applies.
      changes.config = configFor(location, { accessKeyIdHint: hint }) as StorageTarget["config"];
      changes.status = "unverified";
      changes.errorMessage = null;
      changes.checkedAt = null;
    }
    if (changed.length === 0) {
      return row;
    }
    const [updated] = await tx
      .update(storageTargets)
      .set(changes)
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, id)))
      .returning();
    if (!updated) {
      throw notFound();
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: STORAGE_AUDIT_ACTIONS.updated,
      target: id,
      targetType: "storage_target",
      ip: actor.ip,
      details: {
        changed,
        ...(addressingChanged && location ? { location: describeStorageLocation(location) } : {}),
        ...(addressingChanged && currentLocation && next
          ? { moved: movesLocation(currentLocation, next) }
          : {}),
      },
    });
    return updated;
  });
  return toTargetDto(row, actor);
}

function sameAddressing(a: StorageLocation, b: StorageLocation): boolean {
  return JSON.stringify(storageLocationConfig(a)) === JSON.stringify(storageLocationConfig(b));
}

/**
 * Open a `previous` target for reading. Most rows have addressing of their
 * own; the one exception is the retired-installation-default placeholder
 * (`kind: "installation_default"`, `config: {}` —
 * {@link insertRetiredInstallationDefault}), which carries none and opens to
 * the environment's default instead, exactly as an absent primary row does
 * for the worker (`resolveStorageTargets`, packages/core/src/storage/
 * factory.ts). Without this case `openStorageTarget` rejects the placeholder
 * as an `unknown_kind`, which made it permanently undeletable once it no
 * longer held anything exclusive (it could never pass this very check).
 */
async function openPreviousTarget(
  db: Database,
  tenantId: string,
  row: StorageTarget,
  deps: StorageDeps,
): Promise<StorageBackend> {
  if (row.kind === "installation_default") {
    const defaults = await readInstallationDefault(deps);
    if (!defaults) {
      throw defaultUnavailable();
    }
    return openInstallationDefault(defaults).primary.backend;
  }
  return openStorageTarget(row, secretReaderFor(db, tenantId)).then(
    (opened) => opened.backend,
    (error: unknown) => {
      throw openProblem(error);
    },
  );
}

/**
 * Storage keys under this tenant's packs/, manifests/ and keys/ prefixes that
 * still matter to a restore. Retention (apps/worker/src/handlers/retention.ts)
 * and GC (packages/core/src/verify/gc.ts) only ever touch `[primary,
 * ...copies]`, never a retired `previous` target, so a `previous` target
 * accumulates objects those two housekeeping jobs would otherwise have
 * removed: the manifest of a snapshot retention pruned, a pack GC already
 * repacked or dropped, an abandoned `.partial` checkpoint. None of that is
 * exclusive data worth blocking a delete over — it is garbage nothing
 * references any more, and {@link previousTargetExclusiveObjects} must not
 * count it.
 */
async function liveExclusiveObjectKeys(
  db: Database,
  tenantId: string,
): Promise<{
  readonly packs: ReadonlySet<string>;
  readonly manifests: ReadonlySet<string>;
  readonly keys: ReadonlySet<string>;
}> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [packRowsResult, manifestRows, keyRows] = await Promise.all([
      packRows(tx, tenantId),
      tx
        .select({ manifestPath: snapshots.manifestPath })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.tenantId, tenantId),
            eq(snapshots.status, "active"),
            isNotNull(snapshots.manifestPath),
          ),
        ),
      tx
        .select({ keyVersion: tenantKeys.keyVersion })
        .from(tenantKeys)
        .where(eq(tenantKeys.tenantId, tenantId)),
    ]);
    return {
      packs: new Set(packRowsResult.map((pack) => pack.path)),
      manifests: new Set(
        manifestRows.flatMap((row) => (row.manifestPath === null ? [] : [row.manifestPath])),
      ),
      keys: new Set(keyRows.map((row) => wrappedKeyKey(tenantId, row.keyVersion))),
    };
  });
}

/** The endpoints of the tenant that have a restic repository (active or revoked). */
async function endpointRepositoryIds(db: Database, tenantId: string): Promise<string[]> {
  return withTenantTx(db, tenantId, async (tx) =>
    (
      await tx
        .select({ id: endpoints.id })
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, tenantId), isNotNull(endpoints.repositorySecretId)))
    ).map((row) => row.id),
  );
}

/**
 * Whether every pack, manifest and wrapped key this `previous` target holds
 * that still matters also exists on the tenant's current primary or a copy (a
 * fresh, real-storage listing — "Probes and listings talk to real storage, so
 * they never run inside a database transaction", the same rule
 * `completenessOf` and `promoteTarget` follow). A manifest is exactly as
 * exclusive a loss as its packs: without it nothing knows which chunks a
 * snapshot needs, however many of those chunks happen to exist elsewhere.
 * Anything still live and found nowhere else means some snapshot can only
 * ever be restored from this location; removing it would make that snapshot
 * unrestorable with no way back (docs/STORAGE.md, "Removing an old
 * location"). Objects retention or GC would already have removed had they
 * been able to reach this target are not counted (see
 * {@link liveExclusiveObjectKeys}) — otherwise the first prune or scrub after
 * a "move" switch would leave garbage that blocks the delete forever.
 */
async function previousTargetExclusiveObjects(
  db: Database,
  tenantId: string,
  row: StorageTarget,
  rows: readonly StorageTarget[],
  deps: StorageDeps,
): Promise<ExclusiveObjectsCheck & { readonly endpointRepositories: readonly string[] }> {
  const previousBackend = await openPreviousTarget(db, tenantId, row, deps);
  const [primary, copies, live] = await Promise.all([
    openEffectivePrimary(db, tenantId, rows, deps),
    openCopyBackends(db, tenantId, rows),
    liveExclusiveObjectKeys(db, tenantId),
  ]);
  const others = [primary.backend, ...copies];
  const endpointRepositories = await endpointRepositoryIds(db, tenantId);
  const prefixes: ReadonlyArray<{
    readonly prefix: string;
    readonly isLive: (key: string) => boolean;
  }> = [
    { prefix: packPrefix(tenantId), isLive: (key) => live.packs.has(key) },
    { prefix: manifestPrefix(tenantId), isLive: (key) => live.manifests.has(key) },
    { prefix: keyPrefix(tenantId), isLive: (key) => live.keys.has(key) },
  ];
  try {
    const checks = await Promise.all(
      prefixes.map(({ prefix, isLive }) =>
        checkSourceExclusiveObjects({ source: previousBackend, others, prefix, isLive }),
      ),
    );
    // An endpoint repository (docs/AGENT.md) that only this location holds: its `config`
    // object marks the repository; a revoked machine's backups stay restorable from here.
    const endpointKeys: string[] = [];
    for (const endpointId of endpointRepositories) {
      const key = `${endpointPrefix(endpointId)}config`;
      if (!(await previousBackend.head(key))) {
        continue;
      }
      let elsewhere = false;
      for (const other of others) {
        if (await other.head(key)) {
          elsewhere = true;
          break;
        }
      }
      if (!elsewhere) {
        endpointKeys.push(key);
      }
    }
    return {
      exclusive: checks.some((check) => check.exclusive),
      exclusiveKeys: checks.flatMap((check) => check.exclusiveKeys),
      exclusiveKeysOmitted: checks.reduce((sum, check) => sum + check.exclusiveKeysOmitted, 0),
      endpointRepositories: endpointKeys,
    };
  } catch (error) {
    throw new ProblemError(502, "Storage not reachable", {
      type: `${PROBLEM_PREFIX}unreachable`,
      detail: "Listing this location or the current targets failed. Test the targets first.",
      extensions: { code: classifyStorageError(error), error: describeStorageError(error) },
    });
  }
}

export async function deleteTarget(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
  deps: StorageDeps = {},
): Promise<void> {
  const defaults = await readInstallationDefault(deps);
  const { row, rows } = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadTarget(tx, tenantId, id);
    const rows = await loadTargets(tx, tenantId);
    const situation = situationOf(rows, await tenantHasData(tx, tenantId), defaults, actor, id);
    const violation = decideDelete(situation, { role: row.role, kind: row.kind });
    if (violation) {
      throw ruleProblem(violation);
    }
    return { row, rows };
  });

  // Real-storage check, outside any transaction (see the doc comment above);
  // only a retired `previous` target can hold packs unreachable any other
  // way, so only it needs this before removal.
  if (row.role === "previous") {
    const exclusive = await previousTargetExclusiveObjects(db, tenantId, row, rows, deps);
    if (exclusive.endpointRepositories.length > 0) {
      throw previousHoldsEndpointRepositories(exclusive.endpointRepositories);
    }
    if (exclusive.exclusive) {
      throw previousHoldsExclusiveData(exclusive);
    }
  }

  await withTenantTx(db, tenantId, async (tx) => {
    // Re-checked fresh: the row (or the tenant's data) could have changed
    // since the read above, and nothing else re-validates before the delete.
    const fresh = await loadTarget(tx, tenantId, id);
    const freshRows = await loadTargets(tx, tenantId);
    const freshSituation = situationOf(
      freshRows,
      await tenantHasData(tx, tenantId),
      defaults,
      actor,
      id,
    );
    const freshViolation = decideDelete(freshSituation, { role: fresh.role, kind: fresh.kind });
    if (freshViolation) {
      throw ruleProblem(freshViolation);
    }
    // storage_migrations references both its endpoints with onDelete:
    // "restrict" (packages/db/src/schema/storage.ts) on purpose: this row is
    // the evidence a move happened. An unfinished migration must keep
    // blocking the delete; a finished one's evidence already lives in the
    // audit log written when it ran, so its row can be cleared here to free
    // the reference (the other endpoint, if still alive, simply stops
    // showing that finished migration on its own card).
    const referencing = await tx
      .select({ id: storageMigrations.id, status: storageMigrations.status })
      .from(storageMigrations)
      .where(
        and(
          eq(storageMigrations.tenantId, tenantId),
          or(
            eq(storageMigrations.sourceTargetId, id),
            eq(storageMigrations.destinationTargetId, id),
          ),
        ),
      );
    if (referencing.some((migration) => UNFINISHED_MIGRATION_STATUSES.includes(migration.status))) {
      throw migrationBlocksDelete();
    }
    const finishedIds = referencing.map((migration) => migration.id);
    if (finishedIds.length > 0) {
      await tx.delete(storageMigrations).where(inArray(storageMigrations.id, finishedIds));
    }
    await tx
      .delete(storageTargets)
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, id)));
    if (fresh.secretRef) {
      await deleteSecret(tx, { id: fresh.secretRef, tenantId });
    }
    const location = locationOf(fresh);
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: STORAGE_AUDIT_ACTIONS.deleted,
      target: id,
      targetType: "storage_target",
      ip: actor.ip,
      details: {
        name: fresh.name,
        kind: fresh.kind,
        role: fresh.role,
        location: location ? describeStorageLocation(location) : null,
      },
    });
  });
}

// --- Checks ---------------------------------------------------------------------

/** Probe an opened target and, when it works and speaks S3, detect Object Lock. */
async function runChecks(
  target: OpenedStorageTarget,
  tenantId: string,
  options: { requireExistingPath: boolean; now: () => Date },
): Promise<ProbeOutcomeDto> {
  const probe = await target.probe({
    keyPrefix: storageProbePrefix(tenantId),
    requireExistingPath: options.requireExistingPath,
    now: options.now,
  });
  const objectLock =
    target.location.kind === "local" || probe.ok
      ? await target.detectObjectLock(options.now)
      : null;
  return { probe, objectLock };
}

/** Test a stored target and record the outcome with it. */
export async function testTarget(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
  deps: StorageDeps = {},
): Promise<TestResultDto> {
  const now = deps.now ?? (() => new Date());
  const row = await withTenantTx(db, tenantId, (tx) => loadTarget(tx, tenantId, id));
  const location = locationOf(row);
  if (location) {
    await enforceEndpointPolicy(location, actor, deps);
  }
  let opened: OpenedStorageTarget;
  try {
    opened = await openStorageTarget(row, secretReaderFor(db, tenantId), { purpose: "probe" });
  } catch (error) {
    throw openProblem(error);
  }
  const outcome = await runChecks(opened, tenantId, { requireExistingPath: true, now });

  const records: TargetConfigRecords = { lastProbe: outcome.probe };
  if (outcome.objectLock && opened.location.kind === "s3") {
    records.objectLockDetection = outcome.objectLock;
    records.objectLock = outcome.objectLock.status === "enabled";
  }
  const updated = await withTenantTx(db, tenantId, async (tx) => {
    const [saved] = await tx
      .update(storageTargets)
      .set({
        status: outcome.probe.ok ? "ok" : "error",
        errorMessage: outcome.probe.ok ? null : (outcome.probe.error ?? outcome.probe.errorCode),
        checkedAt: new Date(outcome.probe.checkedAt),
        config: mergeRecords(records),
      })
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, id)))
      .returning();
    if (!saved) {
      throw notFound();
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: STORAGE_AUDIT_ACTIONS.tested,
      target: id,
      targetType: "storage_target",
      ip: actor.ip,
      details: probeAuditDetails(outcome),
    });
    return saved;
  });
  return { target: toTargetDto(updated, actor), ...outcome };
}

function probeAuditDetails(outcome: ProbeOutcomeDto): Record<string, unknown> {
  return {
    ok: outcome.probe.ok,
    failedStep: outcome.probe.failedStep,
    errorCode: outcome.probe.errorCode,
    durationMs: outcome.probe.durationMs,
    warnings: outcome.probe.warnings,
    objectLock: outcome.objectLock?.status ?? null,
  };
}

/** Probe settings from the form without storing anything. */
export async function probeSettings(
  db: Database,
  tenantId: string,
  input: ProbeStorageInput,
  actor: Actor,
  deps: StorageDeps = {},
): Promise<ProbeOutcomeDto> {
  const now = deps.now ?? (() => new Date());
  const location = validLocation(input.kind, input.config);
  if (!actor.isProviderAdmin && location.kind === "local") {
    throw ruleProblem("local_requires_provider_admin");
  }
  await enforceEndpointPolicy(location, actor, deps);

  let credentials: S3Credentials | undefined;
  if (input.kind === "s3") {
    credentials = input.credentials
      ? toCredentials(input.credentials)
      : await storedCredentials(db, tenantId, input.targetId, location);
  }
  const outcome = await runChecks(
    openStorageLocation(location, { credentials, purpose: "probe" }),
    tenantId,
    {
      requireExistingPath: true,
      now,
    },
  );
  await audit(db, {
    tenantId,
    actor: actor.email,
    actorUserId: actor.id,
    action: STORAGE_AUDIT_ACTIONS.probed,
    target: describeStorageLocation(location),
    targetType: "storage_location",
    ip: actor.ip,
    details: probeAuditDetails(outcome),
  });
  return outcome;
}

/** The stored credentials of an S3 target, for testing edited settings without re-entering the secret. */
async function storedCredentials(
  db: Database,
  tenantId: string,
  targetId: string | undefined,
  location: StorageLocation,
): Promise<S3Credentials> {
  const row = targetId
    ? await withTenantTx(db, tenantId, (tx) => loadTarget(tx, tenantId, targetId))
    : null;
  if (!row || row.kind !== "s3" || !row.secretRef) {
    throw credentialsRequired();
  }
  if (credentialsBoundElsewhere(locationOf(row), location)) {
    throw credentialsRequired();
  }
  const raw = await readSecret(db, { id: row.secretRef, tenantId });
  try {
    if (raw === null) {
      throw new StorageTargetError("credentials_missing", `secret of target ${row.id} is missing`);
    }
    return parseS3CredentialsSecret(raw);
  } catch (error) {
    throw openProblem(error);
  }
}

/** Test the installation default the tenant uses; nothing is stored (it has no row). */
export async function testInstallationDefault(
  db: Database,
  tenantId: string,
  actor: Actor,
  deps: StorageDeps = {},
): Promise<ProbeOutcomeDto & { installationDefault: InstallationDefaultDto }> {
  const now = deps.now ?? (() => new Date());
  const defaults = await readInstallationDefault(deps);
  if (!defaults) {
    throw defaultUnavailable();
  }
  const inUse = await withTenantTx(db, tenantId, async (tx) =>
    (await loadTargets(tx, tenantId)).every((row) => row.role !== "primary"),
  );
  const opened = openInstallationDefault(defaults, "probe");
  // The default directory is created on the first write, so it need not exist yet.
  const outcome = await runChecks(opened.primary, tenantId, { requireExistingPath: false, now });
  await audit(db, {
    tenantId,
    actor: actor.email,
    actorUserId: actor.id,
    action: STORAGE_AUDIT_ACTIONS.defaultTested,
    target: "installation_default",
    targetType: "storage_location",
    ip: actor.ip,
    details: probeAuditDetails(outcome),
  });
  return { ...outcome, installationDefault: toInstallationDefaultDto(defaults, inUse, actor) };
}

// --- Copies: completeness and promotion ------------------------------------------

async function packRows(
  tx: DbExecutor,
  tenantId: string,
): Promise<{ path: string; size: number }[]> {
  return tx
    .select({ path: packs.path, size: packs.size })
    .from(packs)
    .where(eq(packs.tenantId, tenantId));
}

/** The tenant's current primary: its primary row, else the installation default. */
async function openEffectivePrimary(
  db: Database,
  tenantId: string,
  rows: readonly StorageTarget[],
  deps: StorageDeps,
): Promise<OpenedStorageTarget> {
  const primaryRow = rows.find((row) => row.role === "primary");
  if (primaryRow) {
    return openStorageTarget(primaryRow, secretReaderFor(db, tenantId)).catch((error: unknown) => {
      throw openProblem(error);
    });
  }
  const defaults = await readInstallationDefault(deps);
  if (!defaults) {
    throw defaultUnavailable();
  }
  return openInstallationDefault(defaults).primary;
}

/** Every copy target's backend, opened for reading. */
async function openCopyBackends(
  db: Database,
  tenantId: string,
  rows: readonly StorageTarget[],
): Promise<StorageBackend[]> {
  const copies = rows.filter((row) => row.role === "copy");
  return Promise.all(
    copies.map((row) =>
      openStorageTarget(row, secretReaderFor(db, tenantId)).then(
        (opened) => opened.backend,
        (error: unknown) => {
          throw openProblem(error);
        },
      ),
    ),
  );
}

/** Compare a copy against the tenant's primary by listing both (no reads). */
async function completenessOf(
  db: Database,
  tenantId: string,
  rows: readonly StorageTarget[],
  target: StorageTarget,
  deps: StorageDeps,
): Promise<CopyCompleteness> {
  const primary = await openEffectivePrimary(db, tenantId, rows, deps);
  const copy = await openStorageTarget(target, secretReaderFor(db, tenantId)).catch(
    (error: unknown) => {
      throw openProblem(error);
    },
  );
  const knownPacks = await withTenantTx(db, tenantId, (tx) => packRows(tx, tenantId));
  try {
    return await checkCopyCompleteness({
      tenantId,
      source: primary.backend,
      target: copy.backend,
      packs: knownPacks,
      now: deps.now,
    });
  } catch (error) {
    throw new ProblemError(502, "Storage not reachable", {
      type: `${PROBLEM_PREFIX}unreachable`,
      detail: "Listing the primary or the copy failed. Test both targets.",
      extensions: { code: classifyStorageError(error), error: describeStorageError(error) },
    });
  }
}

/** Does the copy hold everything the primary holds? (listing only) */
export async function checkCompleteness(
  db: Database,
  tenantId: string,
  id: string,
  actor: Pick<Actor, "isProviderAdmin">,
  deps: StorageDeps = {},
): Promise<CompletenessDto> {
  const rows = await withTenantTx(db, tenantId, (tx) => loadTargets(tx, tenantId));
  const target = rows.find((row) => row.id === id);
  if (!target) {
    throw notFound();
  }
  if (target.role === "primary") {
    throw ruleProblem("already_primary");
  }
  const completeness = await completenessOf(db, tenantId, rows, target, deps);
  return { target: toTargetDto(target, actor), completeness };
}

/**
 * Make a copy the primary. It must have passed its last test and hold every
 * pack, manifest and key of the current primary; the current primary target
 * (if any) becomes a copy in the same transaction, so writes keep reaching it.
 */
export async function promoteTarget(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
  deps: StorageDeps = {},
): Promise<PromoteResultDto> {
  const { rows, migrationInProgress } = await withTenantTx(db, tenantId, async (tx) => ({
    rows: await loadTargets(tx, tenantId),
    migrationInProgress: activeMigrationOf(await loadMigrations(tx, tenantId)) !== null,
  }));
  const target = rows.find((row) => row.id === id);
  if (!target) {
    throw notFound();
  }
  const violation = decidePromote(actor, { ...target, migrationInProgress });
  if (violation) {
    throw ruleProblem(violation);
  }
  await assertNoActiveEndpoints(db, tenantId);
  const completeness = await completenessOf(db, tenantId, rows, target, deps);
  if (!completeness.complete) {
    throw copyIncomplete(completeness);
  }

  const { promoted, previousPrimaryId } = await withTenantTx(db, tenantId, async (tx) => {
    const fresh = await loadTarget(tx, tenantId, id);
    if (fresh.role === "primary") {
      throw ruleProblem("already_primary");
    }
    // Re-checked inside this transaction: a migration could have started
    // between the check above and here.
    if (activeMigrationOf(await loadMigrations(tx, tenantId)) !== null) {
      throw ruleProblem("migration_in_progress");
    }
    if (await hasActiveEndpoints(tx, tenantId)) {
      throw activeEndpoints();
    }
    const demoted = await tx
      .update(storageTargets)
      .set({ role: "copy" })
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.role, "primary")))
      .returning({ id: storageTargets.id });
    const [promoted] = await tx
      .update(storageTargets)
      .set({ role: "primary" })
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.id, id)))
      .returning();
    if (!promoted) {
      throw notFound();
    }
    const previousPrimaryId = demoted[0]?.id ?? null;
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: STORAGE_AUDIT_ACTIONS.promoted,
      target: id,
      targetType: "storage_target",
      ip: actor.ip,
      details: {
        previousPrimary: previousPrimaryId ?? "installation_default",
        packs: completeness.packs.expected,
        manifests: completeness.manifests.expected,
        keys: completeness.keys.expected,
      },
    });
    return { promoted, previousPrimaryId };
  });
  return { target: toTargetDto(promoted, actor), previousPrimaryId, completeness };
}

// --- Usage ----------------------------------------------------------------------

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Logical vs physical bytes and the growth of the chunk store (see usage.ts). */
export async function storageUsage(
  db: Database,
  tenantId: string,
  deps: StorageDeps = {},
): Promise<UsageDto> {
  const now = (deps.now ?? (() => new Date()))();
  const from = windowStart(now, SERIES_DAYS + 1);
  const day = sql<string>`to_char(${packs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  return withTenantTx(db, tenantId, async (tx) => {
    const [packTotals] = await tx
      .select({ count: count(), bytes: sql<string>`coalesce(sum(${packs.size}), 0)::text` })
      .from(packs)
      .where(eq(packs.tenantId, tenantId));
    const dailyRows = await tx
      .select({ day, bytes: sql<string>`sum(${packs.size})::text` })
      .from(packs)
      .where(and(eq(packs.tenantId, tenantId), gte(packs.createdAt, from)))
      .groupBy(day);
    const retained = await tx.execute(sql`
      select count(*)::int as snapshot_count, coalesce(sum(${snapshots.byteSize}), 0)::text as bytes
      from ${snapshots}
      where ${snapshots.tenantId} = ${tenantId}
        and ${snapshots.status} = 'active'
        and ${snapshots.completedAt} is not null`);
    const latest = await tx.execute(sql`
      select count(*)::int as object_count, coalesce(sum(latest.byte_size), 0)::text as bytes
      from (
        select distinct on (${snapshots.protectedObjectId}) ${snapshots.byteSize} as byte_size
        from ${snapshots}
        where ${snapshots.tenantId} = ${tenantId}
          and ${snapshots.status} = 'active'
          and ${snapshots.completedAt} is not null
          and ${snapshotNotImported()}
        order by ${snapshots.protectedObjectId}, ${snapshots.sequence} desc
      ) as latest`);

    const retainedRow = (retained.rows[0] ?? {}) as Record<string, unknown>;
    const latestRow = (latest.rows[0] ?? {}) as Record<string, unknown>;
    const daily: DailyBytes[] = dailyRows.map((row) => ({
      day: row.day,
      bytes: toNumber(row.bytes),
    }));
    return buildUsage(
      {
        logicalBytes: toNumber(latestRow.bytes),
        retainedLogicalBytes: toNumber(retainedRow.bytes),
        physicalBytes: toNumber(packTotals?.bytes),
        packCount: toNumber(packTotals?.count),
        snapshotCount: toNumber(retainedRow.snapshot_count),
        protectedObjectCount: toNumber(latestRow.object_count),
      },
      daily,
      now,
    );
  });
}
