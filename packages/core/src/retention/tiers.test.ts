import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIERS,
  KEEP_ALL_TIERS,
  cutoffDays,
  isRetentionPreset,
  presetTiers,
  validateTiers,
} from "./tiers.js";

describe("presetTiers", () => {
  it("resolves every built-in preset to its documented rule", () => {
    expect(presetTiers("default")).toEqual(DEFAULT_TIERS);
    expect(presetTiers("30d")).toEqual([{ fromDays: 0, toDays: 30, keepEveryDays: 0 }]);
    expect(presetTiers("90d")).toEqual([{ fromDays: 0, toDays: 90, keepEveryDays: 0 }]);
    expect(presetTiers("1y")).toEqual([{ fromDays: 0, toDays: 365, keepEveryDays: 0 }]);
    expect(presetTiers("3y")).toEqual([{ fromDays: 0, toDays: 1095, keepEveryDays: 0 }]);
    expect(presetTiers("7y")).toEqual([{ fromDays: 0, toDays: 2555, keepEveryDays: 0 }]);
    expect(presetTiers("keep_all")).toEqual(KEEP_ALL_TIERS);
  });

  it("shapes the default as documented: every point 30 days, daily to 90, weekly to a year", () => {
    expect(DEFAULT_TIERS).toEqual([
      { fromDays: 0, toDays: 30, keepEveryDays: 0 },
      { fromDays: 30, toDays: 90, keepEveryDays: 1 },
      { fromDays: 90, toDays: 365, keepEveryDays: 7 },
    ]);
  });
});

describe("isRetentionPreset", () => {
  it("accepts only the known preset names", () => {
    expect(isRetentionPreset("default")).toBe(true);
    expect(isRetentionPreset("custom")).toBe(true);
    expect(isRetentionPreset("30d")).toBe(true);
    expect(isRetentionPreset("nope")).toBe(false);
    expect(isRetentionPreset(42)).toBe(false);
  });
});

describe("validateTiers", () => {
  it("accepts a contiguous list starting at day 0 with an open-ended last tier", () => {
    expect(
      validateTiers([
        { fromDays: 0, toDays: 30, keepEveryDays: 0 },
        { fromDays: 30, toDays: null, keepEveryDays: 7 },
      ]),
    ).toBeNull();
  });

  it("rejects an empty list", () => {
    expect(validateTiers([])).toMatchObject({ code: "empty" });
  });

  it("rejects a list that does not start at day 0", () => {
    expect(validateTiers([{ fromDays: 5, toDays: null, keepEveryDays: 0 }])).toMatchObject({
      code: "start",
    });
  });

  it("rejects a gap or overlap between tiers", () => {
    expect(
      validateTiers([
        { fromDays: 0, toDays: 30, keepEveryDays: 0 },
        { fromDays: 45, toDays: null, keepEveryDays: 1 },
      ]),
    ).toMatchObject({ code: "gap" });
  });

  it("rejects an open-ended tier that is not last", () => {
    expect(
      validateTiers([
        { fromDays: 0, toDays: null, keepEveryDays: 0 },
        { fromDays: 30, toDays: null, keepEveryDays: 1 },
      ]),
    ).toMatchObject({ code: "open_ended" });
  });

  it("rejects negative or fractional bounds", () => {
    expect(validateTiers([{ fromDays: 0, toDays: 30.5, keepEveryDays: 0 }])).toMatchObject({
      code: "to_days",
    });
    expect(validateTiers([{ fromDays: 0, toDays: 30, keepEveryDays: -1 }])).toMatchObject({
      code: "keep_every_days",
    });
  });
});

describe("cutoffDays", () => {
  it("is the last tier's toDays, or null when it is open-ended", () => {
    expect(cutoffDays(DEFAULT_TIERS)).toBe(365);
    expect(cutoffDays(KEEP_ALL_TIERS)).toBeNull();
  });
});
