import { describe, expect, it } from "vitest";
import { backupOutcomes, objectCountsSchema, tenantSummarySchema } from "./status.js";

describe("backupOutcomes", () => {
  it("counts failed runs and completed runs that left items behind, separately", () => {
    expect(
      backupOutcomes([
        { status: "completed", failedItems: 0 },
        { status: "completed", failedItems: null },
        { status: "completed", failedItems: 312 },
        { status: "completed", failedItems: 1 },
        { status: "failed", failedItems: 4 },
        { status: "failed", failedItems: null },
      ]),
    ).toEqual({ failed: 2, withItemFailures: 2 });
  });

  it("reports a clean tenant as clean", () => {
    expect(backupOutcomes([])).toEqual({ failed: 0, withItemFailures: 0 });
    expect(backupOutcomes([{ status: "completed", failedItems: 0 }])).toEqual({
      failed: 0,
      withItemFailures: 0,
    });
  });

  it("ignores runs that did not finish", () => {
    expect(
      backupOutcomes([
        { status: "active", failedItems: 9 },
        { status: "queued", failedItems: null },
        { status: "cancelled", failedItems: 3 },
      ]),
    ).toEqual({ failed: 0, withItemFailures: 0 });
  });
});

describe("ObjectCounts", () => {
  it("documents objects with failed items next to failed objects", () => {
    const shape = objectCountsSchema.shape;
    expect(Object.keys(shape)).toContain("withItemFailures");
    expect(shape.withItemFailures.description).toMatch(/could not back up some items/);
  });
});

describe("TenantSummary", () => {
  it("documents that readiness is about the newest backup", () => {
    const shape = tenantSummarySchema.shape;
    expect(shape.recoveryReadiness.description).toMatch(/newest backup was not proven/);
    expect(shape.lastVerifyAt.description).toMatch(/last rated/);
  });
});
