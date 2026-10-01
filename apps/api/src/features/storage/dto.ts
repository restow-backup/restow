import {
  type InstallationDefaultStorage,
  type ObjectLockCapability,
  type StorageLocation,
  type StorageProbeResult,
  describeStorageLocation,
  filesystemObjectLock,
  validateStorageLocation,
} from "@restow/core";
import type { StorageMigration, StorageTarget } from "@restow/db";
import { canManageKind } from "./rules.js";

/**
 * Response shapes of the storage feature and the mapping from rows (pure).
 *
 * `storage_targets.config` holds the addressing (the keys the worker reads)
 * plus this feature's records, which have no columns of their own: the last
 * probe, the Object Lock detection and a hint of the stored access key id.
 * Credentials themselves live only in the encrypted secret store.
 */

export interface TargetConfigRecords {
  /** Whether the bucket enforces Object Lock (read by the archive; docs/ARCHIVE.md). */
  objectLock?: boolean;
  objectLockDetection?: ObjectLockCapability | null;
  lastProbe?: StorageProbeResult | null;
  /** Last four characters of the stored access key id, to recognise the key. */
  accessKeyIdHint?: string | null;
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
  kind: StorageTarget["kind"];
  role: StorageTarget["role"];
  /** One-line location: a path or `s3://bucket/prefix (host)`. */
  location: string;
  local: LocalTargetDto | null;
  s3: S3TargetDto | null;
  /** False when the stored addressing no longer passes validation (edited outside Restow). */
  configValid: boolean;
  status: StorageTarget["status"];
  errorMessage: string | null;
  checkedAt: string | null;
  lastProbe: StorageProbeResult | null;
  /** Null until detected (S3); a filesystem is always `unsupported`. */
  objectLock: ObjectLockCapability | null;
  /** Whether the viewer may change, promote or remove this target. */
  canManage: boolean;
  /**
   * The storage migration this target is part of, as the source or the
   * destination (docs/STORAGE.md): the most recent one, whether still running
   * or already finished. Null when this target was never part of one.
   */
  migration: StorageMigrationDto | null;
  createdAt: string;
  updatedAt: string;
}

/** A `storage_migrations` row's lifecycle, mode and progress for the UI. */
export interface StorageMigrationDto {
  id: string;
  mode: StorageMigration["mode"];
  status: StorageMigration["status"];
  sourceTargetId: string | null;
  destinationTargetId: string;
  /** Whether this target is the migration's `source` or its `destination`. */
  role: "source" | "destination";
  objectsTotal: number;
  objectsDone: number;
  bytesTotal: number;
  bytesDone: number;
  /** 0–100, null while the total is not known yet (still enumerating). */
  percent: number | null;
  etaSeconds: number | null;
  errorMessage: string | null;
  /**
   * True when `status` still reads as in flight but the background job
   * behind it already ended for good, or was never created, without the row
   * being reconciled yet: nothing is actually copying or verifying any more
   * (apps/worker/src/handlers/storage-migration.ts's module doc, "a
   * migration whose job later fails for good"). `errorMessage` then carries
   * the job's own failure. Cancelling still works and finalizes the row
   * (`cancelMigration`), and for `move` the admin can retry it from there.
   */
  stalled: boolean;
  /** Whether a tenant admin or provider admin may cancel it right now. */
  cancellable: boolean;
  startedAt: string | null;
  verifiedAt: string | null;
  switchedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * Statuses cancellable from the UI. `switching` is excluded on purpose: the
 * worker commits that atomic step within moments
 * (apps/worker/src/handlers/storage-migration.ts), so a cancel request then
 * would not stop it, only leave a misleading "cancelled" audit entry next to
 * one that says it switched. `service.ts`'s `CANCELLABLE_MIGRATION_STATUSES`
 * matches this — keep the two in lock-step.
 */
const CANCELLABLE_STATUSES: readonly StorageMigration["status"][] = [
  "queued",
  "copying",
  "verifying",
];

/** `role` says which side of the migration the target this DTO is attached to plays. */
export function toMigrationDto(
  row: StorageMigration,
  role: "source" | "destination",
  etaSeconds: number | null,
): StorageMigrationDto {
  const percent =
    row.objectsTotal > 0
      ? Math.min(100, Math.round((row.objectsDone / row.objectsTotal) * 100))
      : null;
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    sourceTargetId: row.sourceTargetId,
    destinationTargetId: row.destinationTargetId,
    role,
    objectsTotal: row.objectsTotal,
    objectsDone: row.objectsDone,
    bytesTotal: row.bytesTotal,
    bytesDone: row.bytesDone,
    percent,
    etaSeconds: CANCELLABLE_STATUSES.includes(row.status) ? etaSeconds : null,
    errorMessage: row.errorMessage,
    stalled: false,
    cancellable: CANCELLABLE_STATUSES.includes(row.status),
    startedAt: iso(row.startedAt),
    verifiedAt: iso(row.verifiedAt),
    switchedAt: iso(row.switchedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Project a migration DTO as stalled (see {@link StorageMigrationDto.stalled}):
 * the ETA no longer means anything and the job's own failure, when there is
 * one, explains the situation better than a bare "in progress" status.
 * `cancellable` stays true; `cancelMigration` accepts the cancel regardless
 * of the displayed status once it finds the job is not live and finalizes
 * the row to match.
 */
export function withStalledJob(
  dto: StorageMigrationDto,
  jobErrorMessage: string | null,
): StorageMigrationDto {
  return {
    ...dto,
    stalled: true,
    etaSeconds: null,
    errorMessage: jobErrorMessage ?? "The background job for this migration is no longer running.",
    cancellable: true,
  };
}

export interface InstallationDefaultDto {
  /** The tenant has no primary target of its own, so the default is its primary. */
  inUse: boolean;
  /** Null when the environment does not describe a usable default. */
  kind: StorageLocation["kind"] | null;
  /** Path or bucket; shown to provider admins only (it describes the server). */
  location: string | null;
  /** The environment configures a copy path (STORAGE_COPY_LOCAL_PATH). */
  hasCopy: boolean;
  copyLocation: string | null;
  /** The environment's storage settings are invalid. */
  misconfigured: boolean;
}

export interface StorageTargetListDto {
  items: StorageTargetDto[];
  installationDefault: InstallationDefaultDto;
  /** The tenant's chunk store holds data (decides whether a new target may be primary). */
  tenantHasData: boolean;
  /** The viewer may configure local (mounted filesystem) targets. */
  canManageLocal: boolean;
}

export function recordsOf(row: Pick<StorageTarget, "config">): TargetConfigRecords {
  return (row.config ?? {}) as TargetConfigRecords;
}

/** The stored addressing, or null when it no longer validates. */
export function locationOf(row: Pick<StorageTarget, "kind" | "config">): StorageLocation | null {
  const validation = validateStorageLocation(row.kind, row.config);
  return validation.ok ? validation.location : null;
}

/** The last four characters of an access key id (never the whole id). */
export function accessKeyIdHint(accessKeyId: string): string {
  return accessKeyId.slice(-4);
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function rawString(config: unknown, key: string): string {
  const value = (config as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : "";
}

export function toTargetDto(
  row: StorageTarget,
  viewer: { readonly isProviderAdmin: boolean },
  migration: StorageMigrationDto | null = null,
): StorageTargetDto {
  const records = recordsOf(row);
  const location = locationOf(row);
  const fallbackLocation =
    row.kind === "local" ? rawString(row.config, "basePath") : rawString(row.config, "bucket");
  return {
    id: row.id,
    name: row.name ?? (location ? describeStorageLocation(location) : fallbackLocation),
    kind: row.kind,
    role: row.role,
    location: location ? describeStorageLocation(location) : fallbackLocation,
    local: location?.kind === "local" ? { basePath: location.basePath } : null,
    s3:
      location?.kind === "s3"
        ? {
            bucket: location.bucket,
            prefix: location.prefix,
            endpoint: location.endpoint,
            region: location.region,
            forcePathStyle: location.forcePathStyle,
            hasCredentials: row.secretRef !== null,
            accessKeyIdHint: records.accessKeyIdHint ?? null,
          }
        : null,
    configValid: location !== null,
    status: row.status,
    errorMessage: row.errorMessage,
    checkedAt: iso(row.checkedAt),
    lastProbe: records.lastProbe ?? null,
    objectLock:
      row.kind === "local"
        ? filesystemObjectLock(row.createdAt)
        : (records.objectLockDetection ?? null),
    canManage: canManageKind(row.kind, viewer.isProviderAdmin),
    migration,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Primary first, then copies by creation. */
export function compareTargets(
  a: Pick<StorageTarget, "role" | "createdAt">,
  b: Pick<StorageTarget, "role" | "createdAt">,
): number {
  if (a.role !== b.role) {
    return a.role === "primary" ? -1 : 1;
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/** Describe the installation default for a viewer; locations stay with provider admins. */
export function toInstallationDefaultDto(
  defaults: InstallationDefaultStorage | null,
  inUse: boolean,
  viewer: { readonly isProviderAdmin: boolean },
): InstallationDefaultDto {
  if (!defaults) {
    return {
      inUse,
      kind: null,
      location: null,
      hasCopy: false,
      copyLocation: null,
      misconfigured: true,
    };
  }
  return {
    inUse,
    kind: defaults.primary.kind,
    location: viewer.isProviderAdmin ? describeStorageLocation(defaults.primary) : null,
    hasCopy: defaults.copy !== null,
    copyLocation:
      viewer.isProviderAdmin && defaults.copy ? describeStorageLocation(defaults.copy) : null,
    misconfigured: false,
  };
}
