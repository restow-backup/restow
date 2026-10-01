import { describe, expect, it } from "vitest";
import {
  dayKeys,
  fillDays,
  leastSquaresSlope,
  linearForecast,
  runningTotals,
  utcDayKey,
  windowStart,
} from "./series.js";

const NOW = new Date("2026-09-23T21:30:00.000Z");

describe("day keys", () => {
  it("counts whole UTC days ending with today, oldest first", () => {
    expect(windowStart(NOW, 3).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(dayKeys(NOW, 3)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
    expect(dayKeys(NOW, 30)).toHaveLength(30);
    expect(dayKeys(NOW, 30)[0]).toBe("2026-08-25");
  });

  it("uses the UTC day, not the server's local one", () => {
    expect(utcDayKey(new Date("2026-09-23T23:59:59.000Z"))).toBe("2026-09-23");
    expect(utcDayKey(new Date("2026-09-24T00:00:00.000Z"))).toBe("2026-09-24");
  });

  it("crosses month and year boundaries", () => {
    expect(dayKeys(new Date("2027-01-01T08:00:00.000Z"), 2)).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("fillDays", () => {
  it("fills days without activity and drops rows outside the window", () => {
    const keys = ["2026-09-21", "2026-09-22", "2026-09-23"];
    const rows = [
      { date: "2026-09-22", n: 4 },
      { date: "2026-09-01", n: 9 },
    ];
    expect(fillDays(keys, rows, (date) => ({ date, n: 0 }))).toEqual([
      { date: "2026-09-21", n: 0 },
      { date: "2026-09-22", n: 4 },
      { date: "2026-09-23", n: 0 },
    ]);
  });
});

describe("runningTotals", () => {
  it("adds each day's writes to what existed before the window", () => {
    expect(
      runningTotals(["2026-09-21", "2026-09-22", "2026-09-23"], 100, [
        { date: "2026-09-21", bytes: 10 },
        { date: "2026-09-23", bytes: 5 },
      ]),
    ).toEqual([
      { date: "2026-09-21", bytes: 110 },
      { date: "2026-09-22", bytes: 110 },
      { date: "2026-09-23", bytes: 115 },
    ]);
  });
});

describe("linear forecast", () => {
  it("fits the slope by least squares", () => {
    expect(leastSquaresSlope([0, 10, 20, 30])).toBe(10);
    expect(leastSquaresSlope([5, 5, 5])).toBe(0);
    expect(leastSquaresSlope([7])).toBe(0);
  });

  it("continues from the last measured value with the fitted slope", () => {
    const series = [
      { date: "2026-09-21", bytes: 100 },
      { date: "2026-09-22", bytes: 200 },
      { date: "2026-09-23", bytes: 300 },
    ];
    const forecast = linearForecast(series, 2);
    expect(forecast).toEqual({
      method: "linear",
      basisDays: 3,
      slopeBytesPerDay: 100,
      points: [
        { date: "2026-09-24", bytes: 400 },
        { date: "2026-09-25", bytes: 500 },
      ],
    });
  });

  it("never projects below zero", () => {
    const shrinking = [
      { date: "2026-09-21", bytes: 300 },
      { date: "2026-09-22", bytes: 150 },
      { date: "2026-09-23", bytes: 0 },
      { date: "2026-09-24", bytes: 10 },
    ];
    for (const point of linearForecast(shrinking, 5)?.points ?? []) {
      expect(point.bytes).toBeGreaterThanOrEqual(0);
    }
  });

  it("offers nothing to extrapolate from an empty or single-day history", () => {
    expect(linearForecast([], 30)).toBeNull();
    expect(linearForecast([{ date: "2026-09-23", bytes: 50 }], 30)).toBeNull();
    expect(
      linearForecast(
        [
          { date: "2026-09-22", bytes: 0 },
          { date: "2026-09-23", bytes: 0 },
        ],
        30,
      ),
    ).toBeNull();
  });
});
