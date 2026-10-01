import type { ObjectState } from "../verify/summary.js";
import type { Granularity } from "./period.js";

/**
 * Response shapes of `GET /api/v1/stats` (the contract the web's stats page,
 * the CSV export and the PDF report are built on).
 *
 * Honesty rules of the contract:
 *   - a dataset whose data source does not exist for the scope (nothing
 *     protected, no backup yet, no Microsoft 365 source for throttling) is
 *     `{ unavailable: reason }`, never a row of zeros;
 *   - a KPI without a value (a rate without runs, a ratio without stored
 *     bytes, a figure whose dataset is unavailable) is `null`, never 0.
 * Zeros that remain are real: a day without failed backups shows 0 failed.
 */

/** Why a dataset has no data source in this scope. */
export const UNAVAILABLE_REASONS = [
  "no_tenants",
  "no_protected_objects",
  "no_backups_yet",
  "no_microsoft_365_source",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export interface Unavailable {
  unavailable: UnavailableReason;
}

/** A dataset: its rows, or the reason it has none. */
export type Dataset<T> = T[] | Unavailable;

export function isUnavailable<T>(dataset: Dataset<T>): dataset is Unavailable {
  return !Array.isArray(dataset);
}

export type StatsScopeName = "tenant" | "provider";

export interface PeriodDto {
  /** First day (UTC), included. */
  from: string;
  /** Last day (UTC), included. */
  to: string;
  granularity: Granularity;
  days: number;
}

export interface PreviousPeriodDto {
  from: string;
  to: string;
}

/** A figure for the period and the same figure for the previous period. */
export interface KpiDto {
  value: number | null;
  previous: number | null;
}

export interface KpisDto {
  /**
   * Succeeded / (succeeded + failed) backup runs that finished in the period
   * (0..1), jobs and agent backups of servers and clients together. A backup
   * of the agent that ended partial counts as succeeded; one that only says it
   * was interrupted (the agent restarted) is left out.
   */
  backupSuccessRate: KpiDto;
  /**
   * Protected objects at the end of the period: active ones, and orphaned ones
   * (gone from their source) while they still have a backup. Excluded objects
   * are not protected. Servers and clients backed up by the agent count too,
   * from their enrollment until they are revoked. The readiness series counts
   * exactly these objects and machines.
   */
  protectedObjects: KpiDto;
  /** The newest backup of every protected object at the end of the period, added up. */
  logicalBytes: KpiDto;
  /** Pack bytes in the chunk store at the end of the period (deduplicated, encrypted). */
  physicalBytes: KpiDto;
  /** Retained snapshot bytes per stored byte at the end of the period. */
  dedupRatio: KpiDto;
  /** Restores that finished (completed or failed) in the period. */
  restores: KpiDto;
  /**
   * Share of protected objects whose newest backup a restore check of that
   * very backup proved restorable (green or yellow; 0..1). A backup newer than
   * the last check is not proven (features/verify/verification-state.ts).
   */
  verifiedShare: KpiDto;
  /** Time Microsoft Graph made finished jobs wait, in seconds. */
  throttlingWaitSeconds: KpiDto;
  /** Items jobs could not process in the period. */
  failedItems: KpiDto;
}

export const KPI_NAMES = [
  "backupSuccessRate",
  "protectedObjects",
  "logicalBytes",
  "physicalBytes",
  "dedupRatio",
  "restores",
  "verifiedShare",
  "throttlingWaitSeconds",
  "failedItems",
] as const satisfies readonly (keyof KpisDto)[];
export type KpiName = (typeof KPI_NAMES)[number];

export interface BackupPointDto {
  t: string;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/** What the backups of a bucket covered (logical) and added to the store (physical). */
export interface VolumePointDto {
  t: string;
  logicalBytes: number;
  physicalBytes: number;
}

/** Physical bytes stored at the end of a bucket. */
export interface StoragePointDto {
  t: string;
  bytes: number;
}

export interface JobDurationDto {
  /** The job queue: backup, restore, verify, directory, scrub, archive, retention. */
  kind: string;
  p50Seconds: number;
  p95Seconds: number;
  count: number;
}

export interface ThrottlingPointDto {
  t: string;
  waitSeconds: number;
  events: number;
}

export interface RestorePointDto {
  t: string;
  completed: number;
  failed: number;
}

/**
 * Protected objects by the rating of their newest backup at the end of a
 * bucket; a backup no check rated yet, and an object never backed up, count
 * as unverified.
 */
export interface ReadinessPointDto {
  t: string;
  green: number;
  yellow: number;
  red: number;
  unverified: number;
}

export interface FailureCauseDto {
  cause: string;
  count: number;
  lastAt: string;
}

export interface TenantRefDto {
  id: string;
  name: string;
}

export interface LargestObjectDto {
  id: string;
  name: string;
  kind: "mailbox" | "onedrive" | "imap";
  logicalBytes: number;
  lastBackupAt: string;
  /** Recovery readiness of the object at the end of the period (verify's object state). */
  state: ObjectState;
  /** The tenant the object belongs to; provider scope only. */
  tenant?: TenantRefDto;
}

export interface TenantRowDto {
  id: string;
  name: string;
  /** Protected objects at the end of the period (see KpisDto.protectedObjects). */
  objects: number;
  successRate: number | null;
  logicalBytes: number;
  physicalBytes: number;
  /** Overall readiness at the end of the period; null when the tenant protects nothing. */
  readiness: "green" | "yellow" | "red" | null;
  /** Failed items in the period. */
  failures: number;
}

export interface SeriesDto {
  backups: Dataset<BackupPointDto>;
  volume: Dataset<VolumePointDto>;
  storage: Dataset<StoragePointDto>;
  jobDurations: Dataset<JobDurationDto>;
  throttling: Dataset<ThrottlingPointDto>;
  restores: Dataset<RestorePointDto>;
  readiness: Dataset<ReadinessPointDto>;
}

export interface TablesDto {
  failuresByCause: Dataset<FailureCauseDto>;
  largestObjects: Dataset<LargestObjectDto>;
  /** Provider scope only: one row per tenant. */
  tenants?: Dataset<TenantRowDto>;
}

export interface StatsDto {
  period: PeriodDto;
  previous: PreviousPeriodDto;
  scope: StatsScopeName;
  kpis: KpisDto;
  series: SeriesDto;
  tables: TablesDto;
  generatedAt: string;
}

/** Every dataset the CSV export offers (`?dataset=`). */
export const DATASET_NAMES = [
  "kpis",
  "backups",
  "volume",
  "storage",
  "jobDurations",
  "throttling",
  "restores",
  "readiness",
  "failuresByCause",
  "largestObjects",
  "tenants",
] as const;
export type DatasetName = (typeof DATASET_NAMES)[number];
