import { describe, expect, it } from "vitest";
import { GIB } from "../endpoints/quota.js";
import {
  FILE_SHARE_QUOTA_THRESHOLDS,
  shareBudgetBytes,
  shareQuotaAlert,
  shareQuotaExceeded,
  shareQuotaLevel,
  shareQuotaPercent,
  shareRemainingBytes,
  tenantShareBudgetBytes,
} from "./budget.js";

const usage = (
  shareUsed: number,
  shareBudget: number | null,
  tenantUsed = 0,
  tenantBudget: number | null = null,
) => ({
  shareUsed,
  shareBudget,
  tenantUsed,
  tenantBudget,
});

describe("file share budgets (7.4)", () => {
  it("are off by default and set in GiB", () => {
    expect(shareBudgetBytes(null)).toBeNull();
    expect(shareBudgetBytes(0)).toBeNull();
    expect(shareBudgetBytes(2)).toBe(2 * GIB);
    const settings = { tenantShareQuotaGib: 10, tenantShareQuotaGibByTenant: { t1: 0, t2: 3 } };
    expect(tenantShareBudgetBytes(settings, "t1")).toBeNull();
    expect(tenantShareBudgetBytes(settings, "t2")).toBe(3 * GIB);
    expect(tenantShareBudgetBytes(settings, "t3")).toBe(10 * GIB);
  });

  it("warn from 80 percent, refuse at 100, and take the fuller budget", () => {
    expect(FILE_SHARE_QUOTA_THRESHOLDS).toEqual({ near: 0.8, clear: 0.7 });
    expect(shareQuotaLevel(usage(79, 100))).toBe("ok");
    expect(shareQuotaLevel(usage(80, 100))).toBe("near");
    expect(shareQuotaLevel(usage(100, 100))).toBe("exceeded");
    expect(shareQuotaLevel(usage(10, 100, 95, 100))).toBe("near");
    expect(shareQuotaLevel(usage(10, null, 100, 100))).toBe("exceeded");
    expect(shareQuotaExceeded(usage(10, null))).toBe(false);
    expect(shareQuotaExceeded(usage(101, 100))).toBe(true);
    expect(shareRemainingBytes(usage(30, 100, 50, 60))).toBe(10);
    expect(shareRemainingBytes(usage(30, null))).toBeNull();
    expect(shareQuotaPercent(usage(81, 100, 0, null))).toBe(81);
    expect(shareQuotaPercent(usage(1, null))).toBeNull();
  });

  it("raise each level once and re-arm below 70 percent", () => {
    expect(shareQuotaAlert(null, usage(50, 100))).toEqual({ kind: "none" });
    expect(shareQuotaAlert(null, usage(85, 100))).toEqual({ kind: "raise", level: "near" });
    expect(shareQuotaAlert("near", usage(85, 100))).toEqual({ kind: "none" });
    expect(shareQuotaAlert("near", usage(100, 100))).toEqual({ kind: "raise", level: "exceeded" });
    expect(shareQuotaAlert("exceeded", usage(75, 100))).toEqual({ kind: "none" });
    expect(shareQuotaAlert("exceeded", usage(69, 100))).toEqual({ kind: "clear" });
    expect(shareQuotaAlert("near", usage(1, null, 69, 100))).toEqual({ kind: "clear" });
  });
});
