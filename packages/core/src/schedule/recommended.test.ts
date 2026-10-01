import { describe, expect, it } from "vitest";
import { scrubModeForCadence, validateCadence } from "./cadence.js";
import { DEFAULT_SCHEDULE_TIMEZONE, RECOMMENDED_SCHEDULE_DEFAULTS } from "./defaults.js";
import {
  type ExistingSchedule,
  coversRecommendation,
  kindsOfRecommendations,
  missingRecommendedSchedules,
  recommendedSchedules,
} from "./recommended.js";

const existing = (overrides: Partial<ExistingSchedule>): ExistingSchedule => ({
  kind: "backup",
  protectedObjectId: null,
  intervalMinutes: 60,
  cron: null,
  ...overrides,
});

describe("recommendedSchedules", () => {
  it("recommends the full set for a Microsoft 365 tenant, in Berlin time by default", () => {
    const set = recommendedSchedules({ hasMicrosoftSource: true });
    expect(set.map((entry) => entry.slot)).toEqual([
      "backup",
      "directory",
      "verify",
      "scrub_sample",
      "scrub_full",
      "retention",
    ]);
    expect(set.every((entry) => entry.timezone === DEFAULT_SCHEDULE_TIMEZONE)).toBe(true);
    expect(DEFAULT_SCHEDULE_TIMEZONE).toBe("Europe/Berlin");
    expect(set.find((entry) => entry.slot === "backup")).toMatchObject({
      intervalMinutes: 480,
      cron: null,
    });
    expect(set.find((entry) => entry.slot === "directory")).toMatchObject({ intervalMinutes: 360 });
    expect(set.find((entry) => entry.slot === "verify")).toMatchObject({ cron: "0 3 * * 0" });
    expect(set.find((entry) => entry.slot === "retention")).toMatchObject({ cron: "30 4 * * *" });
  });

  it("leaves out the directory sync without a Microsoft 365 source and uses the given zone", () => {
    const set = recommendedSchedules({ hasMicrosoftSource: false, timezone: "America/New_York" });
    expect(set.map((entry) => entry.kind)).not.toContain("directory");
    expect(set.every((entry) => entry.timezone === "America/New_York")).toBe(true);
  });

  it("recommends a weekly sampled and a monthly full scrub", () => {
    const scrubs = recommendedSchedules({ hasMicrosoftSource: false }).filter(
      (entry) => entry.kind === "scrub",
    );
    expect(scrubs.map((entry) => [entry.slot, scrubModeForCadence(entry)])).toEqual([
      ["scrub_sample", "sample"],
      ["scrub_full", "full"],
    ]);
  });

  it("only holds cadences the API itself would accept", () => {
    for (const entry of RECOMMENDED_SCHEDULE_DEFAULTS) {
      expect(
        validateCadence({ ...entry, timezone: DEFAULT_SCHEDULE_TIMEZONE }),
        entry.slot,
      ).toBeNull();
    }
  });
});

describe("missingRecommendedSchedules", () => {
  const all = recommendedSchedules({ hasMicrosoftSource: true });

  it("misses everything on a tenant without schedules and nothing once they exist", () => {
    expect(missingRecommendedSchedules([], all)).toEqual(all);
    const applied = all.map((entry) => existing(entry));
    expect(missingRecommendedSchedules(applied, all)).toEqual([]);
  });

  it("counts a tenant-wide schedule of the same kind, whatever its cadence or state", () => {
    const missing = missingRecommendedSchedules(
      [existing({ kind: "backup", intervalMinutes: 120 }), existing({ kind: "verify" })],
      all,
    );
    expect(kindsOfRecommendations(missing)).toEqual(["directory", "scrub", "retention"]);
  });

  it("does not count a schedule narrowed to one object", () => {
    const narrowed = existing({ kind: "backup", protectedObjectId: "object-1" });
    expect(coversRecommendation(narrowed, all[0] as (typeof all)[number])).toBe(false);
    expect(kindsOfRecommendations(missingRecommendedSchedules([narrowed], all))).toContain(
      "backup",
    );
  });

  it("tells a sampled scrub from a full one", () => {
    const weekly = existing({ kind: "scrub", intervalMinutes: null, cron: "0 1 * * 3" });
    const missing = missingRecommendedSchedules([weekly], all);
    expect(missing.map((entry) => entry.slot)).toContain("scrub_full");
    expect(missing.map((entry) => entry.slot)).not.toContain("scrub_sample");
  });
});
