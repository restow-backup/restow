/**
 * Storage budgets of file share repositories (docs/FILESHARES.md 7.4), on the machine budget
 * code (../endpoints/quota.ts) with the file share thresholds: off by default, set per share
 * (`file_shares.quota_gib`) and for all shares of a tenant (the installation setting, or the
 * tenant's own value). At 80 percent the share warns (`file_share.storage_quota`, once, re-armed
 * below 70), at 100 percent the dispatcher refuses to start a backup and the restic route refuses
 * uploads. Restores, copies into the share, retention and checks keep working.
 */
import {
  GIB,
  type QuotaLevel,
  type QuotaThresholds,
  quotaCleared,
  quotaLevelOf,
  quotaRatio,
  remainingQuotaBytes,
} from "../endpoints/quota.js";
import type { FileShareSettings } from "./model.js";

export const FILE_SHARE_QUOTA_THRESHOLDS: QuotaThresholds = { near: 0.8, clear: 0.7 };

/** A budget in GiB as bytes; null, 0 or less means none. */
export function shareBudgetBytes(quotaGib: number | null | undefined): number | null {
  return typeof quotaGib === "number" && Number.isFinite(quotaGib) && quotaGib > 0
    ? Math.round(quotaGib * GIB)
    : null;
}

/** The budget of all shares of a tenant: its own value, else the installation's; null = none. */
export function tenantShareBudgetBytes(
  settings: Pick<FileShareSettings, "tenantShareQuotaGib" | "tenantShareQuotaGibByTenant">,
  tenantId: string,
): number | null {
  const own = settings.tenantShareQuotaGibByTenant[tenantId];
  return shareBudgetBytes(own !== undefined ? own : settings.tenantShareQuotaGib);
}

export interface ShareQuotaUsage {
  /** Bytes the share's repository takes. */
  readonly shareUsed: number;
  readonly shareBudget: number | null;
  /** Bytes all share repositories of the tenant take, this one included. */
  readonly tenantUsed: number;
  readonly tenantBudget: number | null;
}

/** Bytes the share may still add: what the smaller of its two budgets leaves, null for no limit. */
export function shareRemainingBytes(usage: ShareQuotaUsage): number | null {
  return remainingQuotaBytes({
    endpointUsed: usage.shareUsed,
    endpointBudget: usage.shareBudget,
    tenantUsed: usage.tenantUsed,
    tenantBudget: usage.tenantBudget,
  });
}

const RANK: Record<QuotaLevel, number> = { ok: 0, near: 1, exceeded: 2 };

/** The fuller of the share's and the tenant's budget, with the file share thresholds. */
export function shareQuotaLevel(usage: ShareQuotaUsage): QuotaLevel {
  const own = quotaLevelOf(usage.shareUsed, usage.shareBudget, FILE_SHARE_QUOTA_THRESHOLDS);
  const tenant = quotaLevelOf(usage.tenantUsed, usage.tenantBudget, FILE_SHARE_QUOTA_THRESHOLDS);
  return RANK[tenant] > RANK[own] ? tenant : own;
}

/** Whether a new backup must be refused (7.4): a budget is used up. */
export function shareQuotaExceeded(usage: ShareQuotaUsage): boolean {
  return shareQuotaLevel(usage) === "exceeded";
}

/** The share of the fuller budget in use, in percent (rounded down), or null without a budget. */
export function shareQuotaPercent(usage: ShareQuotaUsage): number | null {
  const ratios = [
    quotaRatio(usage.shareUsed, usage.shareBudget),
    quotaRatio(usage.tenantUsed, usage.tenantBudget),
  ].filter((ratio): ratio is number => ratio !== null);
  if (ratios.length === 0) {
    return null;
  }
  const max = Math.max(...ratios);
  return Number.isFinite(max) ? Math.floor(max * 100) : 100;
}

export type ShareQuotaAlertDecision =
  /** Raise `file_share.storage_quota` at this level and remember it. */
  | { kind: "raise"; level: "near" | "exceeded" }
  /** Usage fell below the clear threshold: forget the level that went out (re-armed). */
  | { kind: "clear" }
  | { kind: "none" };

/**
 * What the monitor does with a share's budget: raise the alert when the level rises (near, then
 * exceeded: each once), clear the remembered level once both budgets are below 70 percent.
 */
export function shareQuotaAlert(
  alerted: "near" | "exceeded" | null,
  usage: ShareQuotaUsage,
): ShareQuotaAlertDecision {
  const level = shareQuotaLevel(usage);
  if (level !== "ok" && (alerted === null || RANK[level] > RANK[alerted])) {
    return { kind: "raise", level };
  }
  if (
    alerted !== null &&
    quotaCleared(usage.shareUsed, usage.shareBudget, FILE_SHARE_QUOTA_THRESHOLDS) &&
    quotaCleared(usage.tenantUsed, usage.tenantBudget, FILE_SHARE_QUOTA_THRESHOLDS)
  ) {
    return { kind: "clear" };
  }
  return { kind: "none" };
}
