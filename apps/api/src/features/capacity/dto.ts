import type { TenantKind, TenantStatus } from "@restow/db";
import type { StorageLimitKind } from "../dashboard/storage-growth.js";

/**
 * GET /api/v1/capacity and GET /api/v1/capacity/:tenantId (features/capacity): utilisation and
 * growth per tenant and per repository, with a plain estimate of when a repository runs full.
 * Provider admins only. Dates are UTC days (`YYYY-MM-DD`), bytes are whole bytes, growth is in
 * bytes per day. Nothing here is a fact about the future: the estimate is a straight line through
 * the history (dashboard/growth.ts), and a day appears only where a limit is known.
 */

/** How full a budget is (@restow/core `QuotaLevel`). */
export type CapacityLevel = "ok" | "near" | "exceeded";

/**
 * What a tenant's growth is read from:
 *
 *   samples  the daily size samples (`storage_samples`) of at least a week: the chunk store and
 *            every restic repository, not shrunk afterwards by pruning
 *   packs    the dates of the tenant's packs: the chunk store only (mail and OneDrive data) and
 *            net growth; used until a week of samples exists
 *   none     nothing to read a growth from yet
 */
export type CapacityBasis = "samples" | "packs" | "none";

/** Growth per day over the last 7, 30 and 90 days; null while the history does not reach back that far. */
export interface CapacityGrowthDto {
  days7: number | null;
  days30: number | null;
  days90: number | null;
}

export interface CapacityForecastDto {
  /** Days of history the estimate rests on (never longer than the history). */
  basisDays: number;
  /** The straight line through the history, never below zero. */
  slopeBytesPerDay: number;
  /** From 90 days of history on: the slowest and the fastest growth of its weeks. */
  band: { slowestBytesPerDay: number; fastestBytesPerDay: number } | null;
}

/** The day a repository's free space is used up at the growth of the estimate. */
export interface CapacityFullDto {
  /** The line's day; null when growth is zero or the day lies more than ten years ahead. */
  estimate: string | null;
  /** The fastest growth's day (from 90 days of history on). */
  earliest: string | null;
  /** The slowest growth's day (from 90 days of history on). */
  latest: string | null;
  /** Whole days from today to `estimate`. */
  estimateInDays: number | null;
  /** The nearer of `earliest` and `estimate`: the day to plan for. */
  nearest: string | null;
  /** Whole days from today to `nearest`. */
  nearestInDays: number | null;
}

export interface CapacityLimitDto {
  kind: StorageLimitKind;
  /** The free and the total space of the repository's filesystem (`filesystem` only). */
  freeBytes: number | null;
  totalBytes: number | null;
  /**
   * Why no day is given although a filesystem is known: other data (machines, file shares,
   * containers) is written to it that the history, read from the pack dates, does not count.
   */
  dateWithheld: "other_data" | null;
}

/** A budget that exists: the tenant's machines or file shares against what they may use together. */
export interface CapacityQuotaDto {
  scope: "endpoints" | "file_shares";
  usedBytes: number;
  /** The tenant's common budget; null when only single repositories have a budget of their own. */
  budgetBytes: number | null;
  /** The fullest budget of the scope: the common one or a single repository's. */
  level: CapacityLevel;
  /** Share of the common budget in use, in percent; null without one. */
  percent: number | null;
}

export interface CapacityTenantDto {
  tenantId: string;
  name: string;
  kind: TenantKind;
  status: TenantStatus;
  /** `error`: the figures could not be read; the other fields are empty. */
  state: "ok" | "error";
  /** Everything the tenant stores: the chunk store and the restic repositories. */
  usedBytes: number | null;
  chunkStoreBytes: number | null;
  /** The restic repositories of machines, file shares and containers. */
  repositoryBytes: number | null;
  repositories: { machines: number; fileShares: number; guests: number };
  basis: CapacityBasis;
  /** Days of history the estimate rests on (at most 90, at least 7); 0 without any. */
  historyDays: number;
  growth: CapacityGrowthDto;
  forecast: CapacityForecastDto | null;
  limit: CapacityLimitDto;
  /** Null where no limit is known, without a forecast or while the day is withheld. */
  full: CapacityFullDto | null;
  quotas: CapacityQuotaDto[];
  /** The fullest of the quotas. */
  quotaLevel: CapacityLevel;
}

export interface CapacitySystemDiskDto {
  freeBytes: number | null;
  totalBytes: number | null;
  /** Change of the free space per day (negative: it shrinks) and when it reaches zero at that rate. */
  trend: { bytesPerDay: number; fullOn: string | null; basisHours: number } | null;
}

export interface CapacityKpisDto {
  /** Everything stored, over the tenants listed. */
  totalBytes: number;
  /** Growth per day over the tenants listed: the 30-day figure of each, else its 7-day one. */
  growthBytesPerDay: number | null;
  /** Tenants whose growth is in `growthBytesPerDay`. */
  growthTenants: number;
  /** The server's system disk (provider's own); null when it is not watched. */
  systemDisk: CapacitySystemDiskDto | null;
  /** The earliest day a repository (or the system disk) runs full. */
  earliestFull: {
    date: string;
    inDays: number;
    tenantId: string | null;
    name: string | null;
  } | null;
  /** Tenants with a quota at `near` or `exceeded`. */
  tenantsNearQuota: number;
  /** Tenants whose repository runs full within {@link NEAR_FULL_DAYS} days at the estimate. */
  tenantsNearFull: number;
}

export interface CapacityDto {
  generatedAt: string;
  /** `all`: every tenant the viewer may enter; `tenant`: the one tenant of an installation without the all-tenants view. */
  scope: "all" | "tenant";
  kpis: CapacityKpisDto;
  tenants: CapacityTenantDto[];
  /** Tenants whose figures could not be read. */
  missing: number;
}

/** What one repository of a tenant stores and how it grows. */
export interface CapacityRepositoryDto {
  id: string;
  name: string;
  /** Bytes the repository takes; null until it was measured. */
  usedBytes: number | null;
  /** Its budget in bytes (its own, else the default); null for none. */
  budgetBytes: number | null;
  level: CapacityLevel;
  /** Growth per day, from the daily samples; null while they do not reach back that far. */
  growth: CapacityGrowthDto;
}

export interface CapacityTargetDto {
  id: string;
  name: string | null;
  role: "primary" | "copy";
  kind: "local" | "s3" | "installation_default";
  status: string;
  /** The chunk store's bytes the target holds (every target holds the same). */
  usedBytes: number;
}

/** GET /api/v1/capacity/:tenantId: a tenant's repositories. */
export interface CapacityTenantDetailDto {
  tenantId: string;
  generatedAt: string;
  /** Where the chunk store lives; a tenant on the installation default has `defaultRepository`. */
  targets: CapacityTargetDto[];
  /** The tenant keeps its chunk store on the installation default (no target of its own). */
  defaultRepository: boolean;
  machines: CapacityRepositoryDto[];
  fileShares: CapacityRepositoryDto[];
  guests: CapacityRepositoryDto[];
  /** Repositories that exist but are not listed (the list is bounded, largest first). */
  omitted: { machines: number; fileShares: number; guests: number };
}
