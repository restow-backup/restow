/**
 * Contract types of `/api/v1/storage` (apps/api/src/features/storage). Kept in
 * sync by hand; the API is the source of truth.
 */

export type StorageKind = "local" | "s3" | "installation_default";
/** The two kinds a person can add or edit; `installation_default` is a placeholder no one creates. */
export type EditableKind = "local" | "s3";
export type StorageRole = "primary" | "copy" | "previous";
/** The role a person may choose when adding a target; `previous` is never chosen directly. */
export type AssignableRole = "primary" | "copy";
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

export type ProbeWarning = "ephemeral_path" | "insecure_endpoint" | "cleanup_failed";

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
}

export interface StorageTargetDto {
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
  canManage: boolean;
  /** The storage migration this target is (or was) part of, as source or destination. */
  migration: StorageMigrationDto | null;
  createdAt: string;
  updatedAt: string;
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
}

export interface StorageTargetList {
  items: StorageTargetDto[];
  installationDefault: InstallationDefaultDto;
  tenantHasData: boolean;
  canManageLocal: boolean;
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

export interface StorageUsage {
  logicalBytes: number;
  retainedLogicalBytes: number;
  physicalBytes: number;
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
