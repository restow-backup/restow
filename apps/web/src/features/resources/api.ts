import { apiFetch } from "@/lib/api";

/**
 * Capacity planning (apps/api features/capacity/dto.ts): utilisation and growth per tenant and
 * per repository. Dates are UTC days (`YYYY-MM-DD`), bytes are whole bytes, growth is in bytes
 * per day. Every date is an estimate, given only where a limit is known.
 */

export type CapacityLevel = "ok" | "near" | "exceeded";
export type CapacityBasis = "samples" | "packs" | "none";
export type StorageLimitKind = "filesystem" | "s3" | "shared_default" | "unknown";

export interface CapacityGrowth {
  days7: number | null;
  days30: number | null;
  days90: number | null;
}

export interface CapacityForecast {
  basisDays: number;
  slopeBytesPerDay: number;
  band: { slowestBytesPerDay: number; fastestBytesPerDay: number } | null;
}

export interface CapacityFull {
  estimate: string | null;
  earliest: string | null;
  latest: string | null;
  estimateInDays: number | null;
  nearest: string | null;
  nearestInDays: number | null;
}

export interface CapacityLimit {
  kind: StorageLimitKind;
  freeBytes: number | null;
  totalBytes: number | null;
  dateWithheld: "other_data" | null;
}

export interface CapacityQuota {
  scope: "endpoints" | "file_shares";
  usedBytes: number;
  budgetBytes: number | null;
  level: CapacityLevel;
  percent: number | null;
}

export interface CapacityTenant {
  tenantId: string;
  name: string;
  kind: "customer" | "internal";
  status: "active" | "suspended" | "deleting";
  state: "ok" | "error";
  usedBytes: number | null;
  chunkStoreBytes: number | null;
  repositoryBytes: number | null;
  repositories: { machines: number; fileShares: number; guests: number };
  basis: CapacityBasis;
  historyDays: number;
  growth: CapacityGrowth;
  forecast: CapacityForecast | null;
  limit: CapacityLimit;
  full: CapacityFull | null;
  quotas: CapacityQuota[];
  quotaLevel: CapacityLevel;
}

export interface CapacitySystemDisk {
  freeBytes: number | null;
  totalBytes: number | null;
  trend: { bytesPerDay: number; fullOn: string | null; basisHours: number } | null;
}

export interface CapacityKpis {
  totalBytes: number;
  growthBytesPerDay: number | null;
  growthTenants: number;
  systemDisk: CapacitySystemDisk | null;
  earliestFull: {
    date: string;
    inDays: number;
    tenantId: string | null;
    name: string | null;
  } | null;
  tenantsNearQuota: number;
  tenantsNearFull: number;
}

export interface Capacity {
  generatedAt: string;
  scope: "all" | "tenant";
  kpis: CapacityKpis;
  tenants: CapacityTenant[];
  missing: number;
}

export interface CapacityRepository {
  id: string;
  name: string;
  usedBytes: number | null;
  budgetBytes: number | null;
  level: CapacityLevel;
  growth: CapacityGrowth;
}

export interface CapacityTarget {
  id: string;
  name: string | null;
  role: "primary" | "copy";
  kind: "local" | "s3" | "installation_default";
  status: string;
  usedBytes: number;
}

export interface CapacityTenantDetail {
  tenantId: string;
  generatedAt: string;
  targets: CapacityTarget[];
  defaultRepository: boolean;
  machines: CapacityRepository[];
  fileShares: CapacityRepository[];
  guests: CapacityRepository[];
  omitted: { machines: number; fileShares: number; guests: number };
}

export const capacityKeys = {
  all: ["capacity"] as const,
  overview: () => [...capacityKeys.all, "overview"] as const,
  tenant: (tenantId: string) => [...capacityKeys.all, "tenant", tenantId] as const,
};

/** Provider routes: they name no tenant in the header, the overview spans them. */
export const fetchCapacity = () => apiFetch<Capacity>("/capacity", { tenantId: null });

export const fetchCapacityTenant = (tenantId: string) =>
  apiFetch<CapacityTenantDetail>(`/capacity/${encodeURIComponent(tenantId)}`, { tenantId: null });
