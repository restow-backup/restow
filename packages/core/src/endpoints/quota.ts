/**
 * The storage budget of endpoint repositories (docs/AGENT.md, "Speicherbudget").
 *
 * An agent is append-only, but appending is enough to fill a storage target:
 * a compromised or misconfigured machine could upload until the disk or the
 * bucket that also holds every mailbox backup is full. So every repository has
 * a budget, and all repositories of a tenant share one more:
 *
 *   RESTOW_ENDPOINT_QUOTA_GIB          per endpoint, default 2048 (2 TiB); an
 *                                      admin can set another value per endpoint
 *   RESTOW_ENDPOINT_TENANT_QUOTA_GIB   all endpoints of one tenant together,
 *                                      default 20480 (20 TiB)
 *
 * `0` switches a budget off. An upload that does not fit is refused (the
 * restic endpoint answers 403 with `endpoint-quota-exceeded`), lock files
 * excepted, so a restore on the machine keeps working. At 90 percent the
 * monitor warns; the warning is re-armed once usage is below 80 percent again.
 */

export const GIB = 1024 ** 3;
export const DEFAULT_ENDPOINT_QUOTA_GIB = 2048;
export const DEFAULT_TENANT_ENDPOINT_QUOTA_GIB = 20 * 1024;
/** The largest budget an admin can set for one endpoint (1 PiB). */
export const MAX_ENDPOINT_QUOTA_GIB = 1024 * 1024;
/** From this share of a budget on, the monitor warns. */
export const QUOTA_NEAR_RATIO = 0.9;
/** Below this share a warning that went out is re-armed. */
export const QUOTA_CLEAR_RATIO = 0.8;

export interface EndpointQuotaLimits {
  /** Budget of one endpoint in bytes, unless its settings say otherwise; null for none. */
  readonly endpointBytes: number | null;
  /** Budget of all endpoint repositories of one tenant in bytes; null for none. */
  readonly tenantBytes: number | null;
}

/** A GiB value from the environment: unset or not a number takes the default, 0 means no budget. */
function bytesFromGib(value: string | undefined, fallbackGib: number): number | null {
  const trimmed = value?.trim() ?? "";
  const gib = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : fallbackGib;
  return gib === 0 ? null : Math.round(gib * GIB);
}

/** The installation's budgets (`RESTOW_ENDPOINT_QUOTA_GIB`, `RESTOW_ENDPOINT_TENANT_QUOTA_GIB`). */
export function endpointQuotaLimits(
  env: Record<string, string | undefined> = process.env,
): EndpointQuotaLimits {
  return {
    endpointBytes: bytesFromGib(env.RESTOW_ENDPOINT_QUOTA_GIB, DEFAULT_ENDPOINT_QUOTA_GIB),
    tenantBytes: bytesFromGib(
      env.RESTOW_ENDPOINT_TENANT_QUOTA_GIB,
      DEFAULT_TENANT_ENDPOINT_QUOTA_GIB,
    ),
  };
}

/** The budget of one endpoint in bytes: its own setting, else the installation's default. */
export function endpointBudgetBytes(
  settings: { quotaGib?: number | null } | null | undefined,
  limits: EndpointQuotaLimits,
): number | null {
  const own = settings?.quotaGib;
  if (typeof own === "number" && Number.isFinite(own) && own > 0) {
    return Math.round(own * GIB);
  }
  return limits.endpointBytes;
}

export interface QuotaUsage {
  /** Bytes the endpoint's repository takes. */
  readonly endpointUsed: number;
  readonly endpointBudget: number | null;
  /** Bytes all endpoint repositories of the tenant take, this one included. */
  readonly tenantUsed: number;
  readonly tenantBudget: number | null;
}

/** Bytes the endpoint may still add: what the smaller of its two budgets leaves, null for no limit. */
export function remainingQuotaBytes(usage: QuotaUsage): number | null {
  const left = [
    usage.endpointBudget === null ? null : usage.endpointBudget - usage.endpointUsed,
    usage.tenantBudget === null ? null : usage.tenantBudget - usage.tenantUsed,
  ].filter((value): value is number => value !== null);
  return left.length === 0 ? null : Math.max(0, Math.min(...left));
}

export type QuotaLevel = "ok" | "near" | "exceeded";

/** The share of a budget in use, or null without a budget. */
export function quotaRatio(used: number, budget: number | null): number | null {
  if (budget === null) {
    return null;
  }
  return budget <= 0 ? Number.POSITIVE_INFINITY : used / budget;
}

/** How full a budget is: `exceeded` when nothing fits any more, `near` from 90 percent. */
export function quotaLevelOf(used: number, budget: number | null): QuotaLevel {
  const ratio = quotaRatio(used, budget);
  if (ratio === null) {
    return "ok";
  }
  if (ratio >= 1) {
    return "exceeded";
  }
  return ratio >= QUOTA_NEAR_RATIO ? "near" : "ok";
}
