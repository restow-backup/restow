import { GIB } from "@restow/core";
import { describe, expect, it } from "vitest";
import { machinesQuota, sharesQuota, worseLevel } from "./quota.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const LIMITS = { endpointBytes: 100 * GIB, tenantBytes: 300 * GIB };

const machine = (usedGib: number | null, quotaGib?: number) => ({
  settings: quotaGib === undefined ? {} : { quotaGib },
  repositoryBytes: usedGib === null ? null : usedGib * GIB,
  repositoryMeasuredAt: null,
  quotaRefusedAt: null,
});

describe("machinesQuota", () => {
  it("has none for a tenant without machines", () => {
    expect(machinesQuota([], 0, LIMITS, NOW)).toBeNull();
  });

  it("reads the tenant's common budget and the fullest budget of a machine", () => {
    // A machine at 80 of its 100 GiB, the tenant at 160 of 300 GiB: all fine.
    expect(machinesQuota([machine(80)], 160 * GIB, LIMITS, NOW)).toEqual({
      scope: "endpoints",
      usedBytes: 160 * GIB,
      budgetBytes: 300 * GIB,
      level: "ok",
      percent: 53,
    });
    // A machine at 95 of its 100 GiB is near, whatever the tenant's budget says.
    expect(machinesQuota([machine(10), machine(95)], 105 * GIB, LIMITS, NOW)?.level).toBe("near");
    // A machine's own smaller budget counts.
    expect(machinesQuota([machine(50, 40)], 50 * GIB, LIMITS, NOW)?.level).toBe("exceeded");
    // The tenant's common budget at 95 percent.
    expect(machinesQuota([machine(10)], 285 * GIB, LIMITS, NOW)?.level).toBe("near");
  });

  it("has no common budget when the installation sets none", () => {
    const none = { endpointBytes: null, tenantBytes: null };
    expect(machinesQuota([machine(500)], 500 * GIB, none, NOW)).toMatchObject({
      budgetBytes: null,
      percent: null,
      level: "ok",
    });
  });
});

describe("sharesQuota", () => {
  const settings = { tenantShareQuotaGib: 100, tenantShareQuotaGibByTenant: { own: 10 } };

  it("has none for a tenant without file shares", () => {
    expect(sharesQuota([], 0, settings, "t")).toBeNull();
  });

  it("is near from 80 percent, with the share's own budget or the tenant's", () => {
    const own = sharesQuota(
      [{ repositoryBytes: 9 * GIB, quotaGib: null }],
      9 * GIB,
      settings,
      "own",
    );
    expect(own).toMatchObject({ budgetBytes: 10 * GIB, level: "near", percent: 90 });
    const shareBudget = sharesQuota(
      [{ repositoryBytes: 9 * GIB, quotaGib: 10 }],
      9 * GIB,
      settings,
      "other",
    );
    // The share is at 90 of its own 10 GiB; the tenant's 100 GiB is hardly used.
    expect(shareBudget).toMatchObject({ budgetBytes: 100 * GIB, level: "near", percent: 9 });
    expect(
      sharesQuota([{ repositoryBytes: 10 * GIB, quotaGib: 10 }], 10 * GIB, settings, "other")
        ?.level,
    ).toBe("exceeded");
    expect(
      sharesQuota([{ repositoryBytes: 1 * GIB, quotaGib: null }], 1 * GIB, settings, "other")
        ?.level,
    ).toBe("ok");
  });
});

describe("worseLevel", () => {
  it("is the fuller of two levels", () => {
    expect(worseLevel("ok", "near")).toBe("near");
    expect(worseLevel("exceeded", "near")).toBe("exceeded");
    expect(worseLevel("ok", "ok")).toBe("ok");
  });
});
