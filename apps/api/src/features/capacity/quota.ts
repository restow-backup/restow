import {
  type EndpointQuotaLimits,
  type FileShareSettings,
  quotaLevelOf,
  quotaRatio,
  shareBudgetBytes,
  shareQuotaLevel,
  tenantShareBudgetBytes,
} from "@restow/core";
import type { Endpoint } from "@restow/db";
import { storageOf } from "../endpoints/dto.js";
import type { CapacityLevel, CapacityQuotaDto } from "./dto.js";

/**
 * The quotas that exist, seen per tenant (pure): the common budget of a tenant's machines
 * (`RESTOW_ENDPOINT_TENANT_QUOTA_GIB`, a machine's own budget) and of its file shares (the
 * installation's or the tenant's value, a share's own). The chunk store has no quota. The levels
 * are those of the endpoint and file share pages (@restow/core `quotaLevelOf`,
 * `shareQuotaLevel`), so a tenant reads "near" here when its page says so.
 */

const RANK: Record<CapacityLevel, number> = { ok: 0, near: 1, exceeded: 2 };

/** The fuller of two levels. */
export function worseLevel(a: CapacityLevel, b: CapacityLevel): CapacityLevel {
  return RANK[b] > RANK[a] ? b : a;
}

function percentOf(used: number, budget: number | null): number | null {
  const ratio = quotaRatio(used, budget);
  return ratio === null || !Number.isFinite(ratio)
    ? ratio === null
      ? null
      : 100
    : Math.floor(ratio * 100);
}

export type MachineQuotaRow = Pick<
  Endpoint,
  "settings" | "repositoryBytes" | "repositoryMeasuredAt" | "quotaRefusedAt"
>;

/** The quota of the tenant's machines; null when it has none. */
export function machinesQuota(
  rows: readonly MachineQuotaRow[],
  tenantUsedBytes: number,
  limits: EndpointQuotaLimits,
  now: Date,
): CapacityQuotaDto | null {
  if (rows.length === 0) {
    return null;
  }
  let level: CapacityLevel = quotaLevelOf(tenantUsedBytes, limits.tenantBytes);
  for (const row of rows) {
    level = worseLevel(level, storageOf(row, tenantUsedBytes, limits, now).level);
  }
  return {
    scope: "endpoints",
    usedBytes: tenantUsedBytes,
    budgetBytes: limits.tenantBytes,
    level,
    percent: percentOf(tenantUsedBytes, limits.tenantBytes),
  };
}

export interface ShareQuotaRow {
  repositoryBytes: number | null;
  quotaGib: number | null;
}

/** The quota of the tenant's file shares; null when it has none. */
export function sharesQuota(
  rows: readonly ShareQuotaRow[],
  tenantUsedBytes: number,
  settings: Pick<FileShareSettings, "tenantShareQuotaGib" | "tenantShareQuotaGibByTenant">,
  tenantId: string,
): CapacityQuotaDto | null {
  if (rows.length === 0) {
    return null;
  }
  const tenantBudget = tenantShareBudgetBytes(settings, tenantId);
  let level: CapacityLevel = "ok";
  for (const row of rows) {
    level = worseLevel(
      level,
      shareQuotaLevel({
        shareUsed: row.repositoryBytes ?? 0,
        shareBudget: shareBudgetBytes(row.quotaGib),
        tenantUsed: tenantUsedBytes,
        tenantBudget,
      }),
    );
  }
  return {
    scope: "file_shares",
    usedBytes: tenantUsedBytes,
    budgetBytes: tenantBudget,
    level,
    percent: percentOf(tenantUsedBytes, tenantBudget),
  };
}
