import { describe, expect, it } from "vitest";

import {
  type ChoiceStorage,
  choiceKey,
  DEFAULT_STORAGE_RANGE,
  readChoice,
  STORAGE_RANGES,
  storageRangeDays,
  storageRangeParams,
  writeChoice,
} from "./ranges.js";

function memory(): ChoiceStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

const broken: ChoiceStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("storage ranges", () => {
  it("offers a week, a month, three months and a year", () => {
    expect(STORAGE_RANGES.map(storageRangeDays)).toEqual([7, 30, 90, 365]);
  });

  it("sends no parameters for the default, so the plain request stays canonical", () => {
    expect(storageRangeParams(DEFAULT_STORAGE_RANGE)).toEqual({});
    expect(storageRangeParams("365d")).toEqual({ storageDays: "365" });
    expect(storageRangeParams("90d", "365d")).toEqual({ storageDays: "90", forecastDays: "365" });
    expect(storageRangeParams("30d", "7d")).toEqual({ storageDays: "30", forecastDays: "7" });
  });
});

describe("remembered choices", () => {
  it("remembers a choice per person", () => {
    const storage = memory();
    const anna = choiceKey("storageRange", "anna");
    writeChoice(anna, "365d", storage);
    expect(readChoice(anna, STORAGE_RANGES, "30d", storage)).toBe("365d");
    expect(readChoice(choiceKey("storageRange", "ben"), STORAGE_RANGES, "30d", storage)).toBe(
      "30d",
    );
    expect(anna).toBe("restow.dashboard.storageRange.anna");
  });

  it("drops a stored value that is not offered (any more)", () => {
    const storage = memory();
    storage.items.set("k", "5y");
    expect(readChoice("k", STORAGE_RANGES, "30d", storage)).toBe("30d");
  });

  it("never fails when storage does", () => {
    expect(readChoice("k", STORAGE_RANGES, "30d", broken)).toBe("30d");
    expect(() => writeChoice("k", "7d", broken)).not.toThrow();
    expect(readChoice("k", STORAGE_RANGES, "30d", null)).toBe("30d");
  });
});
