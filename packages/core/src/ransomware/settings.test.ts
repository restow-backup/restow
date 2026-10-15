import { describe, expect, it } from "vitest";

import {
  DEFAULT_RANSOMWARE_SETTINGS,
  RANSOMWARE_SETTING_RANGES,
  resolveRansomwareSettings,
} from "./settings.js";

describe("the installation's thresholds", () => {
  it("are the defaults when nothing is stored", () => {
    expect(resolveRansomwareSettings({})).toEqual(DEFAULT_RANSOMWARE_SETTINGS);
    expect(resolveRansomwareSettings(null)).toEqual(DEFAULT_RANSOMWARE_SETTINGS);
    expect(resolveRansomwareSettings("nonsense")).toEqual(DEFAULT_RANSOMWARE_SETTINGS);
  });

  it("take the stored overrides and keep the rest", () => {
    const resolved = resolveRansomwareSettings({
      enabled: false,
      changeRate: { minItems: 2000 },
      entropy: { highBits: 7.95 },
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.changeRate).toEqual({
      ...DEFAULT_RANSOMWARE_SETTINGS.changeRate,
      minItems: 2000,
    });
    expect(resolved.entropy.highBits).toBe(7.95);
    expect(resolved.deletions).toEqual(DEFAULT_RANSOMWARE_SETTINGS.deletions);
  });

  it("clamp every number into its range and ignore wrong types", () => {
    const resolved = resolveRansomwareSettings({
      baselineRuns: 1000,
      minBaselineRuns: 0,
      changeRate: { madFactor: -3, enabled: "no" },
      entropy: { highBits: 9, minSamples: Number.NaN },
    });
    expect(resolved.baselineRuns).toBe(RANSOMWARE_SETTING_RANGES.baselineRuns[1]);
    expect(resolved.minBaselineRuns).toBe(RANSOMWARE_SETTING_RANGES.minBaselineRuns[0]);
    expect(resolved.changeRate.madFactor).toBe(
      RANSOMWARE_SETTING_RANGES["changeRate.madFactor"][0],
    );
    expect(resolved.changeRate.enabled).toBe(true);
    expect(resolved.entropy.highBits).toBe(8);
    expect(resolved.entropy.minSamples).toBe(DEFAULT_RANSOMWARE_SETTINGS.entropy.minSamples);
  });

  it("never need more baseline runs than they keep", () => {
    const resolved = resolveRansomwareSettings({ baselineRuns: 4, minBaselineRuns: 20 });
    expect(resolved.minBaselineRuns).toBe(4);
  });

  it("have defaults inside their own ranges", () => {
    const flat: Record<string, number> = {
      baselineRuns: DEFAULT_RANSOMWARE_SETTINGS.baselineRuns,
      minBaselineRuns: DEFAULT_RANSOMWARE_SETTINGS.minBaselineRuns,
    };
    for (const group of ["changeRate", "deletions", "renames", "names", "entropy"] as const) {
      for (const [key, value] of Object.entries(DEFAULT_RANSOMWARE_SETTINGS[group])) {
        if (typeof value === "number") flat[`${group}.${key}`] = value;
      }
    }
    for (const [key, [min, max]] of Object.entries(RANSOMWARE_SETTING_RANGES)) {
      expect(flat[key], key).toBeGreaterThanOrEqual(min);
      expect(flat[key], key).toBeLessThanOrEqual(max);
    }
  });
});
