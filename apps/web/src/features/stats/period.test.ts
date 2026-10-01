import { describe, expect, it } from "vitest";

import { statsKeys, statsParams } from "./api.js";
import {
  MAX_PERIOD_DAYS,
  PERIOD_PRESETS,
  type StatsSearch,
  dayStart,
  daysBetween,
  effectiveScope,
  granularityForDays,
  nextStatsSearch,
  parseStatsSearch,
  previousPeriodDays,
  resolvePeriod,
  withCustomRange,
  withPreset,
  withScope,
} from "./period.js";

/** 23 September 2026, 15:30 local time. */
const NOW = new Date(2026, 8, 23, 15, 30);

/** What the router writes to the address bar and reads back after a reload. */
function throughUrl(search: StatsSearch): StatsSearch {
  const url = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined) {
      url.set(key, String(value));
    }
  }
  return parseStatsSearch(Object.fromEntries(new URLSearchParams(url.toString())));
}

describe("parseStatsSearch", () => {
  it("keeps the default period out of the URL", () => {
    expect(parseStatsSearch({})).toEqual({});
    expect(parseStatsSearch({ period: "30d" })).toEqual({});
  });

  it("accepts the other presets and drops unknown values", () => {
    expect(parseStatsSearch({ period: "7d" })).toEqual({ period: "7d" });
    expect(parseStatsSearch({ period: "12m" })).toEqual({ period: "12m" });
    expect(parseStatsSearch({ period: "1y" })).toEqual({});
    expect(parseStatsSearch({ period: 7 })).toEqual({});
  });

  it("drops custom days on a preset", () => {
    expect(parseStatsSearch({ period: "90d", from: "2026-01-01", to: "2026-02-01" })).toEqual({
      period: "90d",
    });
  });

  it("needs both valid ends for a custom period and orders them", () => {
    expect(parseStatsSearch({ period: "custom", from: "2026-09-01", to: "2026-09-15" })).toEqual({
      period: "custom",
      from: "2026-09-01",
      to: "2026-09-15",
    });
    expect(parseStatsSearch({ period: "custom", from: "2026-09-15", to: "2026-09-01" })).toEqual({
      period: "custom",
      from: "2026-09-01",
      to: "2026-09-15",
    });
    expect(parseStatsSearch({ period: "custom", from: "2026-09-01" })).toEqual({});
    expect(parseStatsSearch({ period: "custom", from: "2026-02-30", to: "2026-03-02" })).toEqual(
      {},
    );
    expect(parseStatsSearch({ period: "custom", from: "01.09.2026", to: "2026-09-15" })).toEqual(
      {},
    );
  });

  it("keeps only the provider scope", () => {
    expect(parseStatsSearch({ scope: "provider" })).toEqual({ scope: "provider" });
    expect(parseStatsSearch({ scope: "tenant" })).toEqual({});
    expect(parseStatsSearch({ scope: "everything" })).toEqual({});
  });
});

describe("search changes", () => {
  const custom: StatsSearch = {
    period: "custom",
    from: "2026-09-01",
    to: "2026-09-15",
    scope: "provider",
  };

  it("a preset replaces the custom days and keeps the scope", () => {
    expect(withPreset(custom, "7d")).toEqual({ period: "7d", scope: "provider" });
    expect(withPreset(custom, "30d")).toEqual({ scope: "provider" });
  });

  it("a custom range writes local calendar days", () => {
    expect(withCustomRange({}, new Date(2026, 7, 3), new Date(2026, 7, 31, 23, 59))).toEqual({
      period: "custom",
      from: "2026-08-03",
      to: "2026-08-31",
    });
  });

  it("the tenant scope is the default and not written", () => {
    expect(withScope(custom, "tenant")).toEqual({
      period: "custom",
      from: "2026-09-01",
      to: "2026-09-15",
    });
    expect(withScope({ period: "12m" }, "provider")).toEqual({ period: "12m", scope: "provider" });
  });

  it("ignores a stray from/to when the period is not custom", () => {
    expect(nextStatsSearch({ period: "7d" }, { from: "2026-09-01" })).toEqual({ period: "7d" });
  });

  it("survives a reload unchanged", () => {
    for (const search of [
      {},
      { period: "7d" },
      { period: "12m", scope: "provider" },
      custom,
    ] as StatsSearch[]) {
      expect(throughUrl(search)).toEqual(search);
      expect(resolvePeriod(throughUrl(search), NOW)).toEqual(resolvePeriod(search, NOW));
    }
  });
});

describe("resolvePeriod", () => {
  it("ends the day-based presets today", () => {
    expect(resolvePeriod({ period: "7d" }, NOW)).toMatchObject({
      choice: "7d",
      firstDay: "2026-09-17",
      lastDay: "2026-09-23",
      days: 7,
      granularity: "day",
    });
    expect(resolvePeriod({}, NOW)).toMatchObject({
      choice: "30d",
      firstDay: "2026-08-25",
      lastDay: "2026-09-23",
      days: 30,
      granularity: "day",
    });
    expect(resolvePeriod({ period: "90d" }, NOW)).toMatchObject({
      firstDay: "2026-06-26",
      days: 90,
      granularity: "week",
    });
  });

  it("covers the current month and the eleven before it for 12 months", () => {
    expect(resolvePeriod({ period: "12m" }, NOW)).toMatchObject({
      choice: "12m",
      firstDay: "2025-10-01",
      lastDay: "2026-09-23",
      granularity: "month",
    });
  });

  it("asks the API for calendar days, both included", () => {
    expect(statsParams(resolvePeriod({ period: "7d" }, NOW), "tenant")).toEqual({
      from: "2026-09-17",
      to: "2026-09-23",
      granularity: "day",
      scope: "tenant",
    });
  });

  it("stays the same all day, so the query key does", () => {
    const morning = resolvePeriod({ period: "30d" }, new Date(2026, 8, 23, 0, 0, 1));
    const evening = resolvePeriod({ period: "30d" }, new Date(2026, 8, 23, 23, 59, 59));
    expect(morning).toEqual(evening);
  });

  it("never reaches past today with a custom period", () => {
    expect(
      resolvePeriod({ period: "custom", from: "2026-09-01", to: "2026-10-10" }, NOW),
    ).toMatchObject({ firstDay: "2026-09-01", lastDay: "2026-09-23", days: 23 });
    expect(
      resolvePeriod({ period: "custom", from: "2026-11-01", to: "2026-11-10" }, NOW),
    ).toMatchObject({ firstDay: "2026-09-23", lastDay: "2026-09-23", days: 1 });
  });

  it("keeps a custom period within the two years the API answers for", () => {
    const period = resolvePeriod({ period: "custom", from: "2020-01-01", to: "2026-09-01" }, NOW);
    expect(period).toMatchObject({ lastDay: "2026-09-01", days: MAX_PERIOD_DAYS });
    expect(period.firstDay).toBe("2024-09-01");
  });

  it("lets the granularity follow a custom range", () => {
    expect(granularityForDays(1)).toBe("day");
    expect(granularityForDays(31)).toBe("day");
    expect(granularityForDays(32)).toBe("week");
    expect(granularityForDays(183)).toBe("week");
    expect(granularityForDays(184)).toBe("month");
    expect(
      resolvePeriod({ period: "custom", from: "2025-01-01", to: "2026-01-01" }, NOW).granularity,
    ).toBe("month");
  });

  it("counts calendar days across a daylight saving change", () => {
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(3);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(3);
    expect(dayStart("2026-03-28", 2).getDate()).toBe(30);
  });

  it("names the comparison period of the same length", () => {
    expect(previousPeriodDays(resolvePeriod({ period: "7d" }, NOW))).toEqual({
      firstDay: "2026-09-10",
      lastDay: "2026-09-16",
    });
  });
});

describe("scope and query keys", () => {
  it("allows the provider scope only where permitted", () => {
    expect(effectiveScope({ scope: "provider" }, true)).toBe("provider");
    expect(effectiveScope({ scope: "provider" }, false)).toBe("tenant");
    expect(effectiveScope({}, true)).toBe("tenant");
  });

  it("gives every period and scope its own query key", () => {
    const keys = new Set<string>();
    for (const preset of PERIOD_PRESETS) {
      for (const scope of ["tenant", "provider"] as const) {
        const params = statsParams(resolvePeriod({ period: preset }, NOW), scope);
        keys.add(
          JSON.stringify(statsKeys.overview(scope === "provider" ? "provider" : "t1", params)),
        );
      }
    }
    const custom = statsParams(
      resolvePeriod({ period: "custom", from: "2026-09-01", to: "2026-09-15" }, NOW),
      "tenant",
    );
    keys.add(JSON.stringify(statsKeys.overview("t1", custom)));
    expect(keys.size).toBe(PERIOD_PRESETS.length * 2 + 1);
  });

  it("keeps the key stable for the same view", () => {
    const params = () => statsParams(resolvePeriod({ period: "90d" }, NOW), "tenant");
    expect(statsKeys.overview("tenant:a", params())).toEqual(
      statsKeys.overview("tenant:a", params()),
    );
    expect(statsKeys.overview("tenant:a", params())).not.toEqual(
      statsKeys.overview("tenant:b", params()),
    );
  });
});
