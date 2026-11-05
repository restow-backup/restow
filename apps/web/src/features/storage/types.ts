/**
 * Contract types of `/api/v1/storage` (apps/api/src/features/storage). Kept in
 * sync by hand; the API is the source of truth.
 */

export type StorageKind = "local" | "s3" | "installation_default";
/** The two kinds a person can add or edit; `installation_default` is a placeholder no one creates. */
export type EditableKind = "local" | "s3";
export type StorageRole = "primary" | "copy" | "previous";
/** The role a person may choose when adding a target; `previous` is never chosen directly. */
/** `previous`: an old location attached read-only (docs/STORAGE.md, "Repository repair"). */
export type AssignableRole = "primary" | "copy" | "previous";
export type TargetStatus = "unverified" | "ok" | "error";

/**
 * How a new primary target takes over from the current one when the tenant
 * already has data (docs/STORAGE.md, "Replace the primary"): `move` copies
 * every existing backup across first, `keep` switches immediately and leaves
 * the old target attached read-only.
 */
export type MigrationMode = "move" | "keep";
export type MigrationStatus =
  | "queued"
  | "copying"
  | "verifying"
  | "switching"
  | "completed"
  | "failed"
  | "cancelled";

export type ProbeStep = "location" | "write" | "read" | "list" | "delete";

export type StorageErrorCode =
  | "path_missing"
  | "not_a_directory"
  | "not_writable"
  | "no_space"
  | "access_denied"
  | "invalid_credentials"
  | "bucket_missing"
  | "wrong_region"
  | "unreachable"
  | "tls"
  | "timeout"
  | "integrity"
  | "unknown";

export type ProbeWarning =
  | "ephemeral_path"
  | "insecure_endpoint"
  | "cleanup_failed"
  /** The storage refuses to overwrite or delete what it holds (docs/STORAGE.md). */
  | "write_once";

/**
 * What a test found about overwriting and deleting (docs/STORAGE.md, "Write-once storage"):
 * a write-once target takes backups, but nothing on it is ever deleted.
 */
export interface WriteOnceFinding {
  writeOnce: boolean;
  refused: ("overwrite" | "delete")[];
  /** EPERM, EACCES, EROFS, AccessDenied, object_lock, or ignored (an overwrite that changed nothing). */
  code: string | null;
  checkedAt: string;
}

export interface ProbeStepResult {
  step: ProbeStep;
  ok: boolean;
  durationMs: number;
  errorCode: StorageErrorCode | null;
  error: string | null;
}

export interface ProbeResult {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  steps: ProbeStepResult[];
  failedStep: ProbeStep | null;
  errorCode: StorageErrorCode | null;
  error: string | null;
  warnings: ProbeWarning[];
  /** Absent from an older server and from probes that did not get that far. */
  writeOnce?: WriteOnceFinding | null;
}

export type ObjectLockStatus = "enabled" | "disabled" | "unsupported" | "unknown";

export interface ObjectLockCapability {
  status: ObjectLockStatus;
  mode: "GOVERNANCE" | "COMPLIANCE" | null;
  defaultRetentionDays: number | null;
  defaultRetentionYears: number | null;
  reason: "filesystem" | "provider" | "access_denied" | "error" | null;
  detail: string | null;
  checkedAt: string;
}

export interface LocalTargetDto {
  basePath: string;
}

export interface S3TargetDto {
  bucket: string;
  prefix: string | null;
  endpoint: string | null;
  region: string;
  forcePathStyle: boolean;
  hasCredentials: boolean;
  accessKeyIdHint: string | null;
  /** Plain HTTP over a network, saved before 0.4.0: still used, should move to HTTPS. */
  insecureEndpoint?: boolean;
}

export interface StorageTargetDto {
  /** A directory on the server's system disk (0.4.5): backups that fill it stop the server. */
  onSystemDisk?: boolean;
  id: string;
  name: string;
  kind: StorageKind;
  role: StorageRole;
  location: string;
  local: LocalTargetDto | null;
  s3: S3TargetDto | null;
  configValid: boolean;
  status: TargetStatus;
  errorMessage: string | null;
  checkedAt: string | null;
  lastProbe: ProbeResult | null;
  objectLock: ObjectLockCapability | null;
  /** What the last test found about overwriting and deleting; absent from an older server. */
  writeOnce?: WriteOnceFinding | null;
  canManage: boolean;
  /** The storage migration this target is (or was) part of, as source or destination. */
  migration: StorageMigrationDto | null;
  /** Immutable backups on this repository (docs/STORAGE.md, "Immutable backups"). */
  immutability?: ImmutabilityDto;
  createdAt: string;
  updatedAt: string;
}

/**
 * `compliance` / `governance`: S3 Object Lock, enforced by the storage;
 * `delayed_deletion`: a directory's deletion delay, enforced by Restow only.
 */
export type ImmutabilityMode = "compliance" | "governance" | "delayed_deletion";

export interface ImmutabilityVerification {
  checkedAt: string;
  sampled: number;
  locked: number;
  unlocked: number;
  weakerMode: number;
  missing: number;
  errors: number;
  problems: { key: string; state: string; until: string | null; detail?: string }[];
}

export interface ImmutabilityDto {
  mode: ImmutabilityMode | null;
  days: number;
  kind: "object_lock" | "deletion_delay";
  since: string | null;
  renewalBufferDays: number;
  renewedAt: string | null;
  renewalOverdue: boolean;
  renewal: {
    at: string;
    extended: number;
    alreadyLonger: number;
    missing: number;
    failed: number;
    complete: boolean;
  } | null;
  verification: ImmutabilityVerification | null;
  deferredDeletions: number;
  history: { since: string; days: number; mode: ImmutabilityMode | null }[];
  canLower: boolean;
}

export interface SetImmutabilityInput {
  mode: ImmutabilityMode | null;
  days?: number;
}

export interface SetImmutabilityResult {
  immutability?: ImmutabilityDto;
  objectLock: ObjectLockCapability | null;
}

/** A restore point's protection as its storage reports it (GET .../immutability). */
export interface RestorePointImmutability {
  state: "immutable" | "governance" | "delayed" | "none";
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

export interface StorageMigrationDto {
  id: string;
  mode: MigrationMode;
  status: MigrationStatus;
  sourceTargetId: string | null;
  destinationTargetId: string;
  role: "source" | "destination";
  objectsTotal: number;
  objectsDone: number;
  bytesTotal: number;
  bytesDone: number;
  percent: number | null;
  etaSeconds: number | null;
  errorMessage: string | null;
  /**
   * True when the background job behind this migration already ended for
   * good (or was never created) while `status` still reads as in flight:
   * nothing is actually copying or verifying any more. `errorMessage` then
   * carries the job's own failure; cancelling still works and finalizes it.
   */
  stalled: boolean;
  cancellable: boolean;
  startedAt: string | null;
  verifiedAt: string | null;
  switchedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface InstallationDefaultDto {
  inUse: boolean;
  kind: StorageKind | null;
  location: string | null;
  hasCopy: boolean;
  copyLocation: string | null;
  misconfigured: boolean;
  /** A directory on the server's system disk (0.4.5); absent from an older server. */
  onSystemDisk?: boolean;
  /** What the newest test of the default found about overwriting and deleting. */
  writeOnce?: WriteOnceFinding | null;
}

/** `GET /storage/write-once`: whether the tenant's backups go to write-once storage. */
export interface PrimaryWriteOnce {
  writeOnce: boolean;
  targetName: string | null;
  installationDefault: boolean;
  checkedAt: string | null;
  refused: ("overwrite" | "delete")[];
}

export interface StorageTargetList {
  items: StorageTargetDto[];
  installationDefault: InstallationDefaultDto;
  tenantHasData: boolean;
  canManageLocal: boolean;
  /**
   * Containers or file shares with repositories: "keep existing backups where they are" and
   * promoting a copy are refused (only "move" takes the repositories along). Absent from an
   * older server.
   */
  switchBlockedBy?: { containers: boolean; fileShares: boolean } | null;
}

export interface ProbeOutcome {
  probe: ProbeResult;
  objectLock: ObjectLockCapability | null;
}

export interface TestResult extends ProbeOutcome {
  target: StorageTargetDto;
}

export interface DefaultTestResult extends ProbeOutcome {
  installationDefault: InstallationDefaultDto;
}

export interface CompletenessCount {
  expected: number;
  present: number;
}

export interface CopyCompleteness {
  complete: boolean;
  packs: CompletenessCount & { bytesExpected: number; bytesMissing: number };
  manifests: CompletenessCount;
  keys: CompletenessCount;
  missingSample: string[];
  checkedAt: string;
}

export interface CompletenessResult {
  target: StorageTargetDto;
  completeness: CopyCompleteness;
}

export interface PromoteResult {
  target: StorageTargetDto;
  previousPrimaryId: string | null;
  completeness: CopyCompleteness;
}

export interface UsagePoint {
  date: string;
  bytes: number;
}

export interface GrowthWindow {
  days: number;
  addedBytes: number;
  ratio: number | null;
}

/** What each kind of repository stores; physicalBytes is their sum. */
export interface StoredBySource {
  chunkStore: number;
  endpoints: number;
  fileShares: number;
  pveGuests: number;
}

export interface StorageUsage {
  logicalBytes: number;
  retainedLogicalBytes: number;
  /** Everything stored: the chunk store and the restic repositories. */
  physicalBytes: number;
  /** The breakdown of physicalBytes (absent from an older api: the chunk store alone). */
  stored?: StoredBySource;
  packCount: number;
  snapshotCount: number;
  protectedObjectCount: number;
  growth: { days30: GrowthWindow; days90: GrowthWindow };
  series: UsagePoint[];
  generatedAt: string;
}

// --- Request bodies ---------------------------------------------------------------

export interface LocalConfigInput {
  basePath: string;
}

export interface S3ConfigInput {
  bucket: string;
  prefix?: string | null;
  endpoint?: string | null;
  region?: string | null;
  forcePathStyle?: boolean;
}

export interface S3CredentialsInput {
  accessKeyId: string;
  secretAccessKey: string;
}

export type CreateTargetInput =
  | {
      kind: "local";
      name: string;
      role: AssignableRole;
      config: LocalConfigInput;
      migrationMode?: MigrationMode;
    }
  | {
      kind: "s3";
      name: string;
      role: AssignableRole;
      config: S3ConfigInput;
      credentials: S3CredentialsInput;
      migrationMode?: MigrationMode;
    };

export interface UpdateTargetInput {
  name?: string;
  config?: LocalConfigInput | S3ConfigInput;
  credentials?: S3CredentialsInput;
}

export type ProbeInput =
  | { kind: "local"; config: LocalConfigInput }
  | {
      kind: "s3";
      config: S3ConfigInput;
      credentials?: S3CredentialsInput;
      targetId?: string;
    };

/**
 * The repository repair (docs/STORAGE.md, "Repository repair"): what a scan found for one
 * restic repository of the tenant across every storage target.
 */
export type RepositoryClass =
  | "ok"
  | "elsewhere"
  | "split"
  | "data_only"
  | "password_only"
  | "missing"
  | "conflict";

export interface RepositoryHolding {
  target: string;
  targetName: string;
  role: string;
  config: boolean;
  keys: number;
  files: number;
  snapshots: number;
  password: boolean;
}

export interface RepositoryScanEntry {
  prefix: string;
  kind: "container" | "machine" | "file_share";
  ownerId: string;
  name: string | null;
  class: RepositoryClass;
  holdings: RepositoryHolding[];
  filesToCopy: number;
  activePoints: number;
  repairable: boolean;
}

export interface RepositoryRepairEntry {
  prefix: string;
  kind: RepositoryScanEntry["kind"];
  ownerId: string;
  name: string | null;
  outcome: "merged" | "lost" | "moved_aside" | "unchanged" | "failed";
  copied: number;
  lostPoints: number;
  movedTo: string | null;
  detail: string | null;
}

export interface RepositoryRepairRun<T> {
  id: string;
  kind: "scan" | "apply";
  status: "queued" | "running" | "completed" | "failed";
  scanId: string | null;
  requestedBy: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  result: {
    repositories: T[];
    /** The places a scan could not read; a repair refuses to apply such a scan. */
    unreachable?: { id: string; name: string; reason: string }[];
  } | null;
}

export interface RepositoryRepairs {
  scan: RepositoryRepairRun<RepositoryScanEntry> | null;
  repair: RepositoryRepairRun<RepositoryRepairEntry> | null;
}
