import {
  type EndpointQuotaLimits,
  endpointBudgetBytes,
  endpointQuotaLimits,
  FILE_SHARE_QUOTA_THRESHOLDS,
  type FileShareSettings,
  quotaLevelOf,
  shareBudgetBytes,
} from "@restow/core";
import {
  type Database,
  safeErrorMessage,
  settings,
  type TenantKind,
  type TenantStatus,
  tenants,
} from "@restow/db";
import { and, asc, ne, sql } from "drizzle-orm";
import { mapBounded } from "../../lib/bounded-map.js";
import { featureEnabled } from "../../lib/features.js";
import { type ProviderAccess, providerMayEnterTenant } from "../../lib/provider-access.js";
import { ProblemError } from "../../problem.js";
import { type DayTotal, growthPerDay, type StorageSeries } from "../dashboard/growth.js";
import { loadStorageHistory } from "../dashboard/queries.js";
import {
  resolveStorageLimit,
  type StorageLimit,
  type StorageLimitDeps,
} from "../dashboard/storage-growth.js";
import { freeSpaceTrend } from "../dashboard/system-disk.js";
import { utcDay } from "../stats/period.js";
import { TenantFiguresCache } from "../tenant-jobs/figures-cache.js";
import { TENANT_READS_AT_ONCE } from "../tenant-jobs/service.js";
import type {
  CapacityDto,
  CapacityGrowthDto,
  CapacityKpisDto,
  CapacityLevel,
  CapacityQuotaDto,
  CapacityRepositoryDto,
  CapacitySystemDiskDto,
  CapacityTenantDetailDto,
  CapacityTenantDto,
} from "./dto.js";
import {
  CAPACITY_HISTORY_DAYS,
  chooseBasis,
  GROWTH_HORIZONS,
  growthOf,
  limitAndFull,
  NEAR_FULL_DAYS,
  sampleSeries,
} from "./math.js";
import { machinesQuota, sharesQuota, worseLevel } from "./quota.js";
import { loadFileShareSettings, readRepositories, readTenant } from "./read.js";

/**
 * GET /api/v1/capacity (features/capacity): utilisation and growth per tenant and per repository,
 * for provider admins.
 *
 * It follows the price estimate (settings/pricing-estimate.ts): the tenant list is read on the
 * installation pool; each tenant's figures on the application pool in that tenant's own pinned
 * transaction, a few tenants at a time, and kept for a short while for every viewer. A member of
 * the provider team limited to some tenants gets those. The list of every tenant is the provider
 * view of the dashboard and so needs its gate `dashboard.allTenants`; without it the page shows
 * the installation's one tenant (the oldest the viewer may enter).
 *
 * What a tenant "uses" is the dashboard's physical bytes: the chunk store plus the restic
 * repositories. Its growth is read from the daily size samples (`storage_samples`) once they span
 * a week, until then from the pack dates (chunk store only); the estimate and the day a
 * repository runs full are the dashboard's (dashboard/growth.ts), and a day is given only where a
 * limit is known: a local repository the tenant has to itself (dashboard/storage-growth.ts).
 * Free space is the provider's disk: this route is the provider's.
 */

/** How long a tenant's figures are served again. */
export const CAPACITY_FIGURES_TTL_MS = 30_000;

/** What is known of one tenant: the DTO without the tenant's identity. */
export type TenantFigures = Omit<
  CapacityTenantDto,
  "tenantId" | "name" | "kind" | "status" | "state"
>;

/** The figures shared by the routes, so several open pages cost the database no more than one. */
export const capacityFiguresCache = new TenantFiguresCache<TenantFigures>(CAPACITY_FIGURES_TTL_MS);

export interface CapacityDeps extends StorageLimitDeps {
  /** Each tenant's figures, kept for a short while; without it every request reads them. */
  cache?: TenantFiguresCache<TenantFigures>;
  /** The machine budgets of the installation; omitted, from the environment. */
  quotaLimits?: EndpointQuotaLimits;
  now?: () => Date;
}

/** What a request reads once for all its tenants. */
interface Shared {
  now: Date;
  limits: EndpointQuotaLimits;
  fileShares: () => Promise<FileShareSettings>;
  soleOnDefault: () => Promise<boolean>;
}

const NO_GROWTH: CapacityGrowthDto = { days7: null, days30: null, days90: null };

/** The number of tenants that keep their data on the installation default (no target of their own). */
async function countTenantsOnDefault(providerDb: Database): Promise<number> {
  const [row] = await providerDb
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(tenants)
    .where(
      and(
        ne(tenants.status, "deleting"),
        sql`not exists (select 1 from storage_targets where storage_targets.tenant_id = ${tenants.id} and storage_targets.role = 'primary')`,
      ),
    );
  return row?.n ?? 0;
}

function sharedFor(deps: CapacityDeps, now: Date): Shared {
  let onDefault: Promise<number> | null = null;
  let fileShares: Promise<FileShareSettings> | null = null;
  return {
    now,
    limits: deps.quotaLimits ?? endpointQuotaLimits(deps.env),
    // Started on first use, inside a tenant's own try/catch, so a failure is never left unawaited.
    fileShares: () => (fileShares ??= loadFileShareSettings(deps.providerDb)),
    // A tenant without a target of its own is alone on the default when it is the only one.
    soleOnDefault: async () => {
      onDefault ??= countTenantsOnDefault(deps.providerDb);
      return (await onDefault) === 1;
    },
  };
}

/** The figures of one tenant. */
async function readFigures(
  deps: CapacityDeps,
  tenantId: string,
  shared: Shared,
): Promise<TenantFigures> {
  const { now } = shared;
  const reading = await readTenant(deps.db, tenantId, now);
  const basis = chooseBasis(reading.samples, reading.packs);
  const growth = growthOf(basis, now, reading.samples, reading.packs);
  let series: StorageSeries | null = null;
  if (basis === "samples") {
    series = sampleSeries(now, reading.samples);
  } else if (basis === "packs") {
    series = await loadStorageHistory(deps.db, tenantId, now, CAPACITY_HISTORY_DAYS);
  }
  let limit: StorageLimit;
  try {
    limit = await resolveStorageLimit(deps, tenantId, shared.soleOnDefault);
  } catch (error) {
    // The limit is an extra: a tenant whose repository cannot be looked at still has its figures.
    logFailure("limit", tenantId, error);
    limit = { kind: "unknown", space: null, otherData: false };
  }
  const { limit: limitDto, full, forecast } = limitAndFull({ limit, basis, series });

  const quotas = [
    machinesQuota(reading.machineQuotaRows, reading.repositories.endpoints, shared.limits, now),
    sharesQuota(
      reading.shareQuotaRows,
      reading.repositories.fileShares,
      await shared.fileShares(),
      tenantId,
    ),
  ].filter((quota): quota is CapacityQuotaDto => quota !== null);
  const repositoryBytes =
    reading.repositories.endpoints +
    reading.repositories.fileShares +
    reading.repositories.pveGuests;
  return {
    usedBytes: reading.packs.totalBytes + repositoryBytes,
    chunkStoreBytes: reading.packs.totalBytes,
    repositoryBytes,
    repositories: reading.counts,
    basis,
    historyDays: series?.window.days ?? 0,
    growth,
    forecast,
    limit: limitDto,
    full,
    quotas,
    quotaLevel: quotas.reduce<CapacityLevel>(
      (worst, quota) => worseLevel(worst, quota.level),
      "ok",
    ),
  };
}

function logFailure(what: string, tenantId: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      message: `capacity ${what} read failed`,
      tenantId,
      // Never the failed query with its bound parameters.
      errorMessage: safeErrorMessage(error),
    }),
  );
}

interface TenantRow {
  id: string;
  name: string;
  kind: TenantKind;
  status: TenantStatus;
}

/**
 * The tenants the viewer's page lists: all that are not being deleted and that the member may
 * enter; with the all-tenants view closed, the first of them alone.
 */
async function listTenants(
  deps: CapacityDeps,
  access: ProviderAccess | null,
): Promise<{ rows: TenantRow[]; scope: CapacityDto["scope"] }> {
  const listed = await deps.providerDb
    .select({
      id: tenants.id,
      name: tenants.name,
      kind: tenants.kind,
      status: tenants.status,
      createdAt: tenants.createdAt,
    })
    .from(tenants)
    .where(ne(tenants.status, "deleting"))
    .orderBy(asc(tenants.name), asc(tenants.id));
  const reachable = access
    ? listed.filter((row) => providerMayEnterTenant(access, row.id))
    : listed;
  if (await featureEnabled("dashboard.allTenants", deps.providerDb)) {
    return { rows: reachable, scope: "all" };
  }
  const first = [...reachable].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  )[0];
  return { rows: first ? [first] : [], scope: "tenant" };
}

/** The system disk's free space and its trend, kept by the disk watch (updates/disk-watch.ts). */
async function loadSystemDisk(
  providerDb: Database,
  now: Date,
): Promise<CapacitySystemDiskDto | null> {
  const [row] = await providerDb.select({ alerts: settings.diskAlerts }).from(settings).limit(1);
  const system = row?.alerts?.system;
  if (!system) {
    return null;
  }
  return {
    freeBytes: system.freeBytes ?? null,
    totalBytes: system.totalBytes ?? null,
    trend: freeSpaceTrend(system.samples ?? [], now),
  };
}

/** The installation's figures on top of the page. */
export function buildKpis(
  tenantsListed: readonly CapacityTenantDto[],
  systemDisk: CapacitySystemDiskDto | null,
  now: Date,
): CapacityKpisDto {
  const read = tenantsListed.filter((tenant) => tenant.state === "ok");
  const rates = read
    .map((tenant) => tenant.growth.days30 ?? tenant.growth.days7)
    .filter((rate): rate is number => rate !== null);
  let earliest: CapacityKpisDto["earliestFull"] = null;
  for (const tenant of read) {
    const full = tenant.full;
    if (
      full?.nearest &&
      full.nearestInDays !== null &&
      (!earliest || full.nearest < earliest.date)
    ) {
      earliest = {
        date: full.nearest,
        inDays: full.nearestInDays,
        tenantId: tenant.tenantId,
        name: tenant.name,
      };
    }
  }
  const diskFull = systemDisk?.trend?.fullOn?.slice(0, 10) ?? null;
  if (diskFull && (!earliest || diskFull < earliest.date)) {
    const today = utcDay(now);
    earliest = {
      date: diskFull,
      inDays: Math.round(
        (Date.parse(`${diskFull}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
      ),
      tenantId: null,
      name: null,
    };
  }
  return {
    totalBytes: read.reduce((sum, tenant) => sum + (tenant.usedBytes ?? 0), 0),
    growthBytesPerDay: rates.length > 0 ? rates.reduce((sum, rate) => sum + rate, 0) : null,
    growthTenants: rates.length,
    systemDisk,
    earliestFull: earliest,
    tenantsNearQuota: read.filter((tenant) => tenant.quotaLevel !== "ok").length,
    tenantsNearFull: read.filter(
      (tenant) => tenant.full?.nearestInDays != null && tenant.full.nearestInDays <= NEAR_FULL_DAYS,
    ).length,
  };
}

const EMPTY_FIGURES: TenantFigures = {
  usedBytes: null,
  chunkStoreBytes: null,
  repositoryBytes: null,
  repositories: { machines: 0, fileShares: 0, guests: 0 },
  basis: "none",
  historyDays: 0,
  growth: NO_GROWTH,
  forecast: null,
  limit: { kind: "unknown", freeBytes: null, totalBytes: null, dateWithheld: null },
  full: null,
  quotas: [],
  quotaLevel: "ok",
};

/** GET /api/v1/capacity. `access` is the member's provider access (null = every tenant). */
export async function loadCapacity(
  deps: CapacityDeps,
  access: ProviderAccess | null,
): Promise<CapacityDto> {
  const now = (deps.now ?? (() => new Date()))();
  const { rows, scope } = await listTenants(deps, access);
  deps.cache?.prune();
  const shared = sharedFor(deps, now);

  const answers = await mapBounded(rows, TENANT_READS_AT_ONCE, async (row) => {
    try {
      const load = () => readFigures(deps, row.id, shared);
      const figures = await (deps.cache ? deps.cache.get(row.id, load) : load());
      return { row, figures: figures as TenantFigures | null };
    } catch (error) {
      logFailure("figures", row.id, error);
      return { row, figures: null };
    }
  });
  const listed: CapacityTenantDto[] = answers.map(({ row, figures }) => ({
    tenantId: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    state: figures ? "ok" : "error",
    ...(figures ?? EMPTY_FIGURES),
  }));
  let systemDisk: CapacitySystemDiskDto | null = null;
  try {
    systemDisk = await loadSystemDisk(deps.providerDb, now);
  } catch (error) {
    logFailure("system disk", "", error);
  }
  return {
    generatedAt: now.toISOString(),
    scope,
    kpis: buildKpis(listed, systemDisk, now),
    tenants: listed,
    missing: listed.filter((tenant) => tenant.state === "error").length,
  };
}

// ---------------------------------------------------------------------------
// One tenant's repositories
// ---------------------------------------------------------------------------

function growthOfSamples(
  samples: readonly DayTotal[] | undefined,
  today: string,
): CapacityGrowthDto {
  const totals = samples ?? [];
  const rate = (days: number) => {
    const value = growthPerDay(totals, today, days);
    return value === null ? null : Math.round(value);
  };
  return {
    days7: rate(GROWTH_HORIZONS[0]),
    days30: rate(GROWTH_HORIZONS[1]),
    days90: rate(GROWTH_HORIZONS[2]),
  };
}

/** GET /api/v1/capacity/:tenantId: the repositories of a tenant the viewer may see on the page. */
export async function loadTenantCapacity(
  deps: CapacityDeps,
  access: ProviderAccess | null,
  tenantId: string,
): Promise<CapacityTenantDetailDto> {
  const now = (deps.now ?? (() => new Date()))();
  const { rows } = await listTenants(deps, access);
  if (!rows.some((row) => row.id === tenantId)) {
    throw new ProblemError(404, "Tenant not found");
  }
  const limits = deps.quotaLimits ?? endpointQuotaLimits(deps.env);
  const repositories = await readRepositories(deps.db, tenantId, now);
  const today = utcDay(now);
  const repository = (
    id: string,
    name: string,
    usedBytes: number | null,
    budgetBytes: number | null,
    level: CapacityLevel,
  ): CapacityRepositoryDto => ({
    id,
    name,
    usedBytes,
    budgetBytes,
    level,
    growth: growthOfSamples(repositories.samples.get(id), today),
  });
  return {
    tenantId,
    generatedAt: now.toISOString(),
    targets: repositories.targets.map((target) => ({
      id: target.id,
      name: target.name,
      role: target.role,
      kind: target.kind,
      status: target.status,
      usedBytes: target.bytesUsed,
    })),
    defaultRepository: !repositories.hasPrimaryTarget,
    machines: repositories.machines.map((machine) => {
      const budget = endpointBudgetBytes(machine.settings, limits);
      return repository(
        machine.id,
        machine.displayName?.trim() || machine.hostname,
        machine.repositoryBytes,
        budget,
        quotaLevelOf(machine.repositoryBytes ?? 0, budget),
      );
    }),
    fileShares: repositories.fileShares.map((share) => {
      const budget = shareBudgetBytes(share.quotaGib);
      return repository(
        share.id,
        share.name,
        share.repositoryBytes,
        budget,
        quotaLevelOf(share.repositoryBytes ?? 0, budget, FILE_SHARE_QUOTA_THRESHOLDS),
      );
    }),
    guests: repositories.guests.map((guest) =>
      repository(
        guest.id,
        guest.name?.trim() || String(guest.vmid),
        guest.repositoryBytes,
        null,
        "ok",
      ),
    ),
    omitted: {
      machines: Math.max(0, repositories.totals.machines - repositories.machines.length),
      fileShares: Math.max(0, repositories.totals.fileShares - repositories.fileShares.length),
      guests: Math.max(0, repositories.totals.guests - repositories.guests.length),
    },
  };
}
