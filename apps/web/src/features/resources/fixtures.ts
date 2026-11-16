import type { Capacity, CapacityTenant, CapacityTenantDetail } from "./api.js";

/** Test fixtures of the capacity page: tenants in every state the page has a word for. */

const NO_GROWTH = { days7: null, days30: null, days90: null };

export function tenantFixture(
  id: string,
  name: string,
  extra: Partial<CapacityTenant> = {},
): CapacityTenant {
  return {
    tenantId: id,
    name,
    kind: "customer",
    status: "active",
    state: "ok",
    usedBytes: 0,
    chunkStoreBytes: 0,
    repositoryBytes: 0,
    repositories: { machines: 0, fileShares: 0, guests: 0 },
    basis: "none",
    historyDays: 0,
    growth: NO_GROWTH,
    forecast: null,
    limit: { kind: "unknown", freeBytes: null, totalBytes: null, dateWithheld: null },
    full: null,
    quotas: [],
    quotaLevel: "ok",
    ...extra,
  };
}

const GB = 1e9;
const forecast = { basisDays: 30, slopeBytesPerDay: 2 * GB, band: null };

/** Runs full in 40 days; a quota near its budget. */
export const ALPHA = tenantFixture("alpha", "Alpha AG", {
  usedBytes: 100 * GB,
  chunkStoreBytes: 60 * GB,
  repositoryBytes: 40 * GB,
  repositories: { machines: 2, fileShares: 0, guests: 0 },
  basis: "samples",
  historyDays: 30,
  growth: { days7: 2 * GB, days30: 1.5 * GB, days90: null },
  forecast,
  limit: { kind: "filesystem", freeBytes: 80 * GB, totalBytes: 200 * GB, dateWithheld: null },
  full: {
    estimate: "2026-12-09",
    earliest: null,
    latest: null,
    estimateInDays: 40,
    nearest: "2026-12-09",
    nearestInDays: 40,
  },
  quotas: [
    { scope: "endpoints", usedBytes: 40 * GB, budgetBytes: 44 * GB, level: "near", percent: 90 },
  ],
  quotaLevel: "near",
});

/** Runs full in 500 days, within its budget. */
export const BETA = tenantFixture("beta", "Beta KG", {
  usedBytes: 30 * GB,
  chunkStoreBytes: 30 * GB,
  basis: "samples",
  historyDays: 90,
  growth: { days7: 1 * GB, days30: 1 * GB, days90: 1 * GB },
  forecast: {
    basisDays: 90,
    slopeBytesPerDay: 1 * GB,
    band: { slowestBytesPerDay: 0.5 * GB, fastestBytesPerDay: 2 * GB },
  },
  limit: { kind: "filesystem", freeBytes: 500 * GB, totalBytes: 1000 * GB, dateWithheld: null },
  full: {
    estimate: "2028-03-13",
    earliest: "2027-07-10",
    latest: "2030-01-01",
    estimateInDays: 500,
    nearest: "2027-07-10",
    nearestInDays: 253,
  },
});

/** S3: no limit known. */
export const GAMMA = tenantFixture("gamma", "Gamma GmbH", {
  usedBytes: 10 * GB,
  chunkStoreBytes: 10 * GB,
  basis: "packs",
  historyDays: 60,
  growth: { days7: 0.2 * GB, days30: null, days90: null },
  forecast: { basisDays: 60, slopeBytesPerDay: 0.2 * GB, band: null },
  limit: { kind: "s3", freeBytes: null, totalBytes: null, dateWithheld: null },
});

/** On the shared default repository, nothing grows yet. */
export const DELTA = tenantFixture("delta", "Delta SE", {
  limit: { kind: "shared_default", freeBytes: null, totalBytes: null, dateWithheld: null },
});

/** A local repository, but no history yet. */
export const EPSILON = tenantFixture("epsilon", "Epsilon Ltd", {
  usedBytes: 1 * GB,
  chunkStoreBytes: 1 * GB,
  limit: { kind: "filesystem", freeBytes: 10 * GB, totalBytes: 20 * GB, dateWithheld: null },
});

/** A local repository that machines write to as well, history from the pack dates only. */
export const ZETA = tenantFixture("zeta", "Zeta Inc", {
  usedBytes: 20 * GB,
  chunkStoreBytes: 15 * GB,
  repositoryBytes: 5 * GB,
  basis: "packs",
  historyDays: 40,
  growth: { days7: 1 * GB, days30: null, days90: null },
  forecast: { basisDays: 40, slopeBytesPerDay: 1 * GB, band: null },
  limit: {
    kind: "filesystem",
    freeBytes: 100 * GB,
    totalBytes: 200 * GB,
    dateWithheld: "other_data",
  },
});

export const BROKEN = tenantFixture("broken", "Broken Ltd", {
  state: "error",
  usedBytes: null,
  chunkStoreBytes: null,
  repositoryBytes: null,
});

export const CAPACITY: Capacity = {
  generatedAt: "2026-10-30T12:00:00.000Z",
  scope: "all",
  kpis: {
    totalBytes: 161 * GB,
    growthBytesPerDay: 3.7 * GB,
    growthTenants: 4,
    systemDisk: {
      freeBytes: 80 * GB,
      totalBytes: 200 * GB,
      trend: { bytesPerDay: -2 * GB, fullOn: "2026-12-09T12:00:00.000Z", basisHours: 48 },
    },
    earliestFull: { date: "2026-12-09", inDays: 40, tenantId: "alpha", name: "Alpha AG" },
    tenantsNearQuota: 1,
    tenantsNearFull: 1,
  },
  tenants: [ALPHA, BETA, GAMMA, DELTA, EPSILON, ZETA, BROKEN],
  missing: 1,
};

export const ALPHA_DETAIL: CapacityTenantDetail = {
  tenantId: "alpha",
  generatedAt: "2026-10-30T12:00:00.000Z",
  targets: [
    { id: "t1", name: null, role: "primary", kind: "local", status: "ok", usedBytes: 60 * GB },
    { id: "t2", name: "Offsite", role: "copy", kind: "s3", status: "error", usedBytes: 60 * GB },
  ],
  defaultRepository: false,
  machines: [
    {
      id: "m1",
      name: "web01",
      usedBytes: 40 * GB,
      budgetBytes: 44 * GB,
      level: "near",
      growth: { days7: 1 * GB, days30: null, days90: null },
    },
    {
      id: "m2",
      name: "web02",
      usedBytes: null,
      budgetBytes: null,
      level: "ok",
      growth: { days7: null, days30: null, days90: null },
    },
  ],
  fileShares: [],
  guests: [],
  omitted: { machines: 3, fileShares: 0, guests: 0 },
};
