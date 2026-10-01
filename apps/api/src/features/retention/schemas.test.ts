import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  createRetentionPolicySchema,
  resolveTiers,
  updateRetentionPolicySchema,
} from "./schemas.js";

describe("resolveTiers", () => {
  it("resolves a built-in preset without needing tiers", () => {
    expect(resolveTiers("30d", undefined)).toEqual([{ fromDays: 0, toDays: 30, keepEveryDays: 0 }]);
  });

  it("requires at least one tier for a custom policy", () => {
    expect(() => resolveTiers("custom", undefined)).toThrow(ProblemError);
    expect(() => resolveTiers("custom", [])).toThrow(ProblemError);
    try {
      resolveTiers("custom", undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).extensions?.field).toBe("tiers");
      expect((error as ProblemError).status).toBe(422);
    }
  });

  it("rejects a custom tier list with a gap, naming the field", () => {
    try {
      resolveTiers("custom", [
        { fromDays: 0, toDays: 10, keepEveryDays: 0 },
        { fromDays: 20, toDays: null, keepEveryDays: 1 },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as ProblemError).extensions?.issues).toMatchObject([{ path: ["tiers"] }]);
    }
  });

  it("accepts a usable custom tier list", () => {
    const tiers = [
      { fromDays: 0, toDays: 14, keepEveryDays: 0 },
      { fromDays: 14, toDays: null, keepEveryDays: 3 },
    ];
    expect(resolveTiers("custom", tiers)).toEqual(tiers);
  });
});

describe("createRetentionPolicySchema", () => {
  it("accepts a tenant-wide (default) policy without object ids", () => {
    const parsed = createRetentionPolicySchema.parse({ name: "Standard", preset: "default" });
    expect(parsed).toMatchObject({ name: "Standard", preset: "default", protectedObjectIds: null });
  });

  it("rejects an empty object id list (ambiguous with the tenant default)", () => {
    expect(() =>
      createRetentionPolicySchema.parse({ name: "x", preset: "30d", protectedObjectIds: [] }),
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      createRetentionPolicySchema.parse({ name: "x", preset: "30d", extra: true }),
    ).toThrow();
  });
});

describe("updateRetentionPolicySchema", () => {
  it("refuses an empty patch", () => {
    expect(() => updateRetentionPolicySchema.parse({})).toThrow();
  });

  it("accepts a partial patch", () => {
    expect(updateRetentionPolicySchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });
});
