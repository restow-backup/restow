import { describe, expect, it } from "vitest";
import {
  GIB,
  endpointBudgetBytes,
  endpointQuotaLimits,
  quotaLevelOf,
  quotaRatio,
  remainingQuotaBytes,
} from "./quota.js";

describe("the storage budget of endpoint repositories", () => {
  it("defaults to 2 TiB per endpoint and 20 TiB per tenant", () => {
    expect(endpointQuotaLimits({})).toEqual({
      endpointBytes: 2048 * GIB,
      tenantBytes: 20480 * GIB,
    });
  });

  it("reads the budgets from the environment; 0 switches one off, nonsense keeps the default", () => {
    expect(
      endpointQuotaLimits({
        RESTOW_ENDPOINT_QUOTA_GIB: "50",
        RESTOW_ENDPOINT_TENANT_QUOTA_GIB: "0",
      }),
    ).toEqual({ endpointBytes: 50 * GIB, tenantBytes: null });
    expect(
      endpointQuotaLimits({
        RESTOW_ENDPOINT_QUOTA_GIB: "0.5",
        RESTOW_ENDPOINT_TENANT_QUOTA_GIB: "-3",
      }),
    ).toEqual({ endpointBytes: GIB / 2, tenantBytes: 20480 * GIB });
    expect(endpointQuotaLimits({ RESTOW_ENDPOINT_QUOTA_GIB: " lots " }).endpointBytes).toBe(
      2048 * GIB,
    );
  });

  it("takes an endpoint's own budget over the installation's default", () => {
    const limits = { endpointBytes: 100 * GIB, tenantBytes: null };
    expect(endpointBudgetBytes({ quotaGib: 3000 }, limits)).toBe(3000 * GIB);
    expect(endpointBudgetBytes({}, limits)).toBe(100 * GIB);
    expect(endpointBudgetBytes(null, limits)).toBe(100 * GIB);
    expect(endpointBudgetBytes({ quotaGib: null }, limits)).toBe(100 * GIB);
    expect(endpointBudgetBytes({ quotaGib: 0 }, limits)).toBe(100 * GIB);
    expect(endpointBudgetBytes({}, { endpointBytes: null, tenantBytes: null })).toBeNull();
  });

  it("leaves what the smaller of the two budgets leaves", () => {
    expect(
      remainingQuotaBytes({
        endpointUsed: 40,
        endpointBudget: 100,
        tenantUsed: 950,
        tenantBudget: 1000,
      }),
    ).toBe(50);
    expect(
      remainingQuotaBytes({
        endpointUsed: 40,
        endpointBudget: 100,
        tenantUsed: 0,
        tenantBudget: null,
      }),
    ).toBe(60);
    expect(
      remainingQuotaBytes({
        endpointUsed: 40,
        endpointBudget: null,
        tenantUsed: 1,
        tenantBudget: null,
      }),
    ).toBeNull();
    // Over budget (an upload in flight overshot it): nothing left, never a negative number.
    expect(
      remainingQuotaBytes({
        endpointUsed: 140,
        endpointBudget: 100,
        tenantUsed: 0,
        tenantBudget: null,
      }),
    ).toBe(0);
  });

  it("warns from 90 percent and calls a budget exceeded when it is used up", () => {
    expect(quotaLevelOf(10, null)).toBe("ok");
    expect(quotaLevelOf(89, 100)).toBe("ok");
    expect(quotaLevelOf(90, 100)).toBe("near");
    expect(quotaLevelOf(100, 100)).toBe("exceeded");
    expect(quotaLevelOf(0, 0)).toBe("exceeded");
    expect(quotaRatio(25, 100)).toBe(0.25);
    expect(quotaRatio(25, null)).toBeNull();
  });
});
