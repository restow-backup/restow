import { describe, expect, it } from "vitest";

import { KPI_NAMES, type Kpi, type StatsOverview } from "./api.js";
import {
  axisLabel,
  boundsToDays,
  byteTicks,
  countTicks,
  dedupFigures,
  dedupUnavailableReason,
  durationTicks,
  formatDayRange,
  formatDuration,
  formatShare,
  isEmptySeries,
  kpiChange,
  longLabel,
  maxStacked,
  objectStateTone,
  readinessTone,
  runRateTone,
  sumOf,
} from "./presenters.js";

/** Intl uses thin, narrow and non-breaking spaces; compare with plain ones. */
const plain = (text: string) => text.replace(/[\u00a0\u2009\u202f]/g, " ");

function kpis(overrides: Partial<Record<(typeof KPI_NAMES)[number], Kpi>>): StatsOverview["kpis"] {
  const base = Object.fromEntries(
    KPI_NAMES.map((name) => [name, { status: "ok", value: null, previous: null }]),
  ) as StatsOverview["kpis"];
  return { ...base, ...overrides };
}

describe("number formatting", () => {
  it("formats shares with one decimal in the UI language", () => {
    expect(plain(formatShare(0.994, "en"))).toBe("99.4%");
    expect(plain(formatShare(0.994, "de"))).toBe("99,4 %");
    expect(plain(formatShare(1.5, "en"))).toBe("100%");
    expect(plain(formatShare(Number.NaN, "en"))).toBe("0%");
  });

  it("never shows a share with failures as 100 %", () => {
    // 2499 of 2500 runs succeeded: the failed one must not round away.
    expect(plain(formatShare(2499 / 2500, "en"))).toBe("99.9%");
    expect(plain(formatShare(2499 / 2500, "de"))).toBe("99,9 %");
    expect(plain(formatShare(199 / 200, "en"))).toBe("99.5%");
    expect(plain(formatShare(1, "en"))).toBe("100%");
  });

  it("formats durations in their two largest units", () => {
    expect(formatDuration(0, "en")).toBe("0 sec");
    expect(formatDuration(45, "en")).toBe("45 sec");
    expect(formatDuration(3600, "en")).toBe("1 hr");
    expect(formatDuration(4830, "en")).toBe("1 hr 20 min");
    expect(formatDuration(90_061, "en")).toBe("1 day 1 hr");
    expect(formatDuration(3601, "en")).toBe("1 hr");
    expect(plain(formatDuration(4800, "de"))).toBe("1 Std. 20 Min.");
    expect(formatDuration(-5, "en")).toBe("0 sec");
  });
});

describe("axis ticks", () => {
  it("steps bytes in round binary units", () => {
    expect(byteTicks(0)).toEqual([0]);
    const gib = 1024 ** 3;
    expect(byteTicks(150 * gib)).toEqual([0, 50 * gib, 100 * gib, 150 * gib]);
  });

  it("steps counts in round whole numbers", () => {
    expect(countTicks(0)).toEqual([0]);
    expect(countTicks(1)).toEqual([0, 1]);
    expect(countTicks(3)).toEqual([0, 1, 2, 3]);
    expect(countTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(countTicks(380)).toEqual([0, 100, 200, 300, 400]);
    expect(countTicks(90)).toEqual([0, 25, 50, 75, 100]);
  });

  it("steps durations in round units", () => {
    expect(durationTicks(0)).toEqual([0]);
    expect(durationTicks(3600)).toEqual([0, 900, 1800, 2700, 3600]);
    expect(durationTicks(50)).toEqual([0, 15, 30, 45, 60]);
    expect(durationTicks(40 * 86_400).at(-1)).toBeGreaterThanOrEqual(40 * 86_400);
  });
});

describe("series helpers", () => {
  const rows = [
    { t: "a", succeeded: 3, failed: 1 },
    { t: "b", succeeded: 0, failed: 4 },
  ];

  it("detects a period in which nothing happened", () => {
    expect(isEmptySeries([], ["succeeded"])).toBe(true);
    expect(isEmptySeries([{ t: "a", succeeded: 0, failed: 0 }], ["succeeded", "failed"])).toBe(
      true,
    );
    expect(isEmptySeries(rows, ["succeeded", "failed"])).toBe(false);
  });

  it("sums and stacks", () => {
    expect(sumOf(rows, "failed")).toBe(5);
    expect(maxStacked(rows, ["succeeded", "failed"])).toBe(4);
  });
});

describe("dates", () => {
  it("labels buckets by granularity", () => {
    expect(axisLabel("2026-09-23", "day", "en")).toBe("Sep 23");
    expect(axisLabel("2026-09-01", "month", "en")).toBe("Sep 26");
    expect(longLabel("2026-09-01", "month", "en")).toBe("September 2026");
    expect(longLabel("2026-09-21", "week", "de")).toBe("21. September 2026");
    expect(axisLabel("not a date", "day", "en")).toBe("not a date");
  });

  it("formats a day range compactly", () => {
    expect(plain(formatDayRange("2026-08-25", "2026-09-23", "en"))).toBe("Aug 25 – Sep 23, 2026");
    expect(plain(formatDayRange("2026-09-23", "2026-09-23", "en"))).toBe("Sep 23, 2026");
  });

  it("reads the server's comparison period", () => {
    // Date bounds are inclusive days.
    expect(boundsToDays({ from: "2026-08-26", to: "2026-09-24" })).toEqual({
      firstDay: "2026-08-26",
      lastDay: "2026-09-24",
    });
    // An instant as the end is exclusive: the period ends the day before.
    const from = new Date(2026, 7, 26).toISOString();
    const to = new Date(2026, 8, 25).toISOString();
    expect(boundsToDays({ from, to })).toEqual({ firstDay: "2026-08-26", lastDay: "2026-09-24" });
    expect(boundsToDays({ from: "later", to })).toBeNull();
    expect(boundsToDays({ from: to, to: from })).toBeNull();
  });
});

describe("key figures", () => {
  it("measures share changes in percentage points", () => {
    expect(kpiChange({ status: "ok", value: 0.98, previous: 0.95 }, "share")).toBe(3);
    expect(kpiChange({ status: "ok", value: 0.9, previous: 0.925 }, "share")).toBe(-2.5);
  });

  it("measures other changes as the plain difference", () => {
    expect(kpiChange({ status: "ok", value: 10, previous: 12 }, "count")).toBe(-2);
    expect(kpiChange({ status: "ok", value: 2048, previous: 1024 }, "bytes")).toBe(1024);
  });

  it("invents no change without both values", () => {
    expect(kpiChange({ status: "ok", value: 10, previous: null }, "count")).toBeNull();
    expect(kpiChange({ status: "ok", value: null, previous: 3 }, "count")).toBeNull();
    expect(kpiChange({ status: "unavailable", reason: "x" }, "count")).toBeNull();
  });

  it("derives deduplication from the volumes", () => {
    expect(
      dedupFigures(
        kpis({
          logicalBytes: { status: "ok", value: 4000, previous: 3000 },
          physicalBytes: { status: "ok", value: 1000, previous: 1500 },
        }),
      ),
    ).toEqual({ savings: 0.75, previousSavings: 0.5, factor: 4 });
  });

  it("prefers the server's ratio over the volumes", () => {
    const figures = dedupFigures(
      kpis({
        logicalBytes: { status: "ok", value: 4000, previous: 3000 },
        physicalBytes: { status: "ok", value: 1000, previous: 1500 },
        dedupRatio: { status: "ok", value: 5, previous: 2 },
      }),
    );
    expect(figures).toEqual({ savings: 0.8, previousSavings: 0.5, factor: 5 });
  });

  it("never reports negative savings", () => {
    expect(
      dedupFigures(kpis({ dedupRatio: { status: "ok", value: 0.8, previous: null } })),
    ).toEqual({ savings: 0, previousSavings: null, factor: 0.8 });
  });

  it("has no deduplication figure without data", () => {
    expect(dedupFigures(kpis({}))).toBeNull();
    expect(
      dedupFigures(
        kpis({
          logicalBytes: { status: "ok", value: 0, previous: 0 },
          physicalBytes: { status: "ok", value: 0, previous: 0 },
        }),
      ),
    ).toBeNull();
  });

  it("names why deduplication is unavailable only when no source exists", () => {
    expect(dedupUnavailableReason(kpis({}))).toBeNull();
    expect(
      dedupUnavailableReason(
        kpis({
          physicalBytes: { status: "unavailable", reason: "no_pack_sizes" },
          dedupRatio: { status: "unavailable", reason: "no_ratio" },
        }),
      ),
    ).toBe("no_pack_sizes");
    expect(
      dedupUnavailableReason(
        kpis({
          physicalBytes: { status: "unavailable", reason: "no_pack_sizes" },
          dedupRatio: { status: "ok", value: 2, previous: null },
        }),
      ),
    ).toBeNull();
  });
});

describe("status tones", () => {
  it("maps readiness and object states", () => {
    expect(readinessTone("green")).toBe("success");
    expect(readinessTone("yellow")).toBe("warning");
    expect(readinessTone("red")).toBe("destructive");
    expect(readinessTone("unverified")).toBe("muted");
    expect(readinessTone(null)).toBe("muted");
    // A protected object is in scope and backed up; only a Ready rating is proof.
    expect(objectStateTone("active")).toBe("neutral");
    expect(objectStateTone("green")).toBe("success");
    expect(objectStateTone("orphaned")).toBe("warning");
    expect(objectStateTone("failed")).toBe("destructive");
    expect(objectStateTone("something new")).toBe("muted");
  });

  it("rates the share of backup runs that completed, never as green", () => {
    // Every run completed: in order, but no restore check has read the backups back.
    expect(runRateTone(1)).toBe("neutral");
    // One failed run in 2500 is not an "all good".
    expect(runRateTone(2499 / 2500)).toBe("warning");
    expect(runRateTone(0.95)).toBe("warning");
    expect(runRateTone(0.5)).toBe("destructive");
    expect(runRateTone(null)).toBe("muted");
    for (const rate of [null, 0, 0.5, 0.95, 2499 / 2500, 1]) {
      expect(runRateTone(rate), String(rate)).not.toBe("success");
    }
  });
});
