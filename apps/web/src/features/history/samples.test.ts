import { describe, expect, it } from "vitest";
import type { SamplePoint } from "./api";
import {
  CHART_BOX,
  CHART_WINDOW_MS,
  SMOOTHED_SERIES,
  TRANSFER_AVERAGE_MS,
  boxFor,
  chartSeries,
  formatClock,
  indexAtFraction,
  moveCrosshair,
  nearestStep,
  niceMax,
  pathOf,
  rateSteps,
  scaleOf,
  smoothedRateSteps,
  sparkline,
  summaryOf,
  tickCount,
  timeAtX,
  unitFor,
  windowOf,
} from "./samples";

const points = (...rows: [number, number, number][]): SamplePoint[] => rows;

describe("rateSteps", () => {
  it("turns cumulative counters into the speed of every step", () => {
    expect(rateSteps(points([0, 0, 0], [2000, 4000, 200], [4000, 6000, 600]))).toEqual([
      { at: 2000, processed: 2000, transferred: 100 },
      { at: 4000, processed: 1000, transferred: 200 },
    ]);
  });

  it("counts a counter that went back as standing still and skips steps without time", () => {
    expect(rateSteps(points([0, 9000, 900], [2000, 100, 10]))).toEqual([
      { at: 2000, processed: 0, transferred: 0 },
    ]);
    expect(rateSteps(points([1000, 0, 0], [1000, 5, 5]))).toEqual([]);
    expect(rateSteps(points([1000, 0, 0]))).toEqual([]);
    expect(rateSteps([])).toEqual([]);
  });
});

describe("windowOf", () => {
  const history = points(
    [0, 0, 0],
    [60_000, 1, 1],
    [200_000, 2, 2],
    [300_000, 3, 3],
    [400_000, 4, 4],
  );

  it("keeps the newest window and one older point to start its first step from", () => {
    expect(windowOf(history, CHART_WINDOW_MS)).toEqual(
      points([60_000, 1, 1], [200_000, 2, 2], [300_000, 3, 3], [400_000, 4, 4]),
    );
  });

  it("keeps everything for a finished run", () => {
    expect(windowOf(history, null)).toEqual(history);
    expect(windowOf([], 1000)).toEqual([]);
  });

  it("keeps the newest point alone when everything else is out of the window", () => {
    expect(windowOf(points([0, 0, 0], [1000, 1, 1]), 10)).toEqual(points([0, 0, 0], [1000, 1, 1]));
    expect(windowOf(points([0, 0, 0], [1_000_000, 1, 1]), 10)).toEqual(
      points([0, 0, 0], [1_000_000, 1, 1]),
    );
  });
});

describe("axes", () => {
  it("rounds a maximum up to 1, 2, 5 or 10 times a power of ten", () => {
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1.4)).toBe(2);
    expect(niceMax(3.1)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(430)).toBe(500);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });

  it("picks one unit for a whole axis", () => {
    expect(unitFor(500)).toEqual({ unit: "B", divisor: 1 });
    expect(unitFor(5_000)).toEqual({ unit: "KB", divisor: 1024 });
    expect(unitFor(300 * 1024 * 1024)).toEqual({ unit: "MB", divisor: 1024 * 1024 });
    expect(unitFor(2 * 1024 ** 3).unit).toBe("GB");
  });

  it("maps time and value into the plot", () => {
    const scale = scaleOf(0, 1000, 80);
    const inner = CHART_BOX.width - CHART_BOX.left - CHART_BOX.right;
    expect(scale.x(0)).toBe(CHART_BOX.left);
    expect(scale.x(1000)).toBe(CHART_BOX.left + inner);
    expect(scale.max).toBe(100);
    // Zero sits on the axis, the maximum at the top of the plot.
    expect(scale.y(0)).toBe(CHART_BOX.height - CHART_BOX.bottom);
    expect(scale.y(scale.max)).toBe(CHART_BOX.top);
    expect(scale.y(-5)).toBe(scale.y(0));
  });

  it("draws at the pixels the container has, with tighter margins and fewer labels on a phone", () => {
    const phone = boxFor(306);
    expect(phone.width).toBe(306);
    expect(phone.left + phone.right).toBeLessThan(CHART_BOX.left + CHART_BOX.right);
    expect(tickCount(phone)).toBe(3);
    // The plot keeps room for the end label next to the line.
    expect(phone.right).toBeGreaterThanOrEqual(66);

    const drawer = boxFor(700);
    expect(drawer).toEqual(CHART_BOX);
    expect(tickCount(drawer)).toBe(5);

    // Never absurdly small or large, whatever the container reports.
    expect(boxFor(0).width).toBe(240);
    expect(boxFor(5000).width).toBe(900);
  });
});

describe("pathOf", () => {
  it("draws the line, its fill down to the axis and where it ends", () => {
    const steps = rateSteps(points([0, 0, 0], [1000, 100, 0], [2000, 300, 0]));
    const scale = scaleOf(0, 2000, 200);
    const path = pathOf(steps, "processed", scale);
    expect(path.line.split(" ")).toHaveLength(2);
    // The fill starts on the axis below the first point and comes back to the axis below the last.
    const corners = path.area.split(" ").map((pair) => pair.split(",").map(Number));
    expect(corners[0]?.[0]).toBeCloseTo(scale.x(1000), 1);
    expect(corners[0]?.[1]).toBeCloseTo(scale.y(0), 1);
    expect(corners[corners.length - 1]?.[0]).toBeCloseTo(scale.x(2000), 1);
    expect(corners[corners.length - 1]?.[1]).toBeCloseTo(scale.y(0), 1);
    expect(path.last?.x).toBeCloseTo(scale.x(2000), 1);
    expect(pathOf([], "processed", scale)).toEqual({ line: "", area: "", last: null });
  });
});

describe("the crosshair", () => {
  it("finds the step under the pointer and stays inside the series", () => {
    expect(indexAtFraction(0, 10)).toBe(0);
    expect(indexAtFraction(1, 10)).toBe(9);
    expect(indexAtFraction(0.5, 11)).toBe(5);
    expect(indexAtFraction(-3, 10)).toBe(0);
    expect(indexAtFraction(7, 10)).toBe(9);
    expect(indexAtFraction(0.5, 0)).toBe(0);
  });

  it("starts at the newest step on the first arrow and stops at both ends", () => {
    expect(moveCrosshair(null, "left", 10)).toBe(8);
    expect(moveCrosshair(null, "right", 10)).toBe(9);
    expect(moveCrosshair(0, "left", 10)).toBe(0);
    expect(moveCrosshair(9, "right", 10)).toBe(9);
    expect(moveCrosshair(4, "right", 10)).toBe(5);
    expect(moveCrosshair(4, "start", 10)).toBe(0);
    expect(moveCrosshair(4, "end", 10)).toBe(9);
    expect(moveCrosshair(null, "end", 0)).toBe(0);
  });
});

describe("summaryOf", () => {
  it("names the current speed, the average and the peak", () => {
    const steps = rateSteps(points([0, 0, 0], [1000, 100, 10], [2000, 400, 20], [3000, 500, 60]));
    expect(summaryOf(steps, "processed")).toEqual({ current: 100, average: 500 / 3, peak: 300 });
    expect(summaryOf(steps, "transferred")).toEqual({ current: 40, average: 20, peak: 40 });
    expect(summaryOf([], "processed")).toEqual({ current: 0, average: 0, peak: 0 });
  });
});

describe("sparkline", () => {
  it("fits a line into the box and ends on its newest point", () => {
    const spark = sparkline(
      points([0, 0, 0], [1000, 100, 0], [2000, 400, 0], [3000, 500, 0]),
      112,
      26,
    );
    expect(spark.line.split(" ")).toHaveLength(3);
    for (const pair of spark.line.split(" ")) {
      const [x, y] = pair.split(",").map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(112);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(26);
    }
    expect(spark.area.endsWith(`${spark.last?.x},26`)).toBe(true);
  });

  it("is empty without a step, and a single step still shows", () => {
    expect(sparkline(points([0, 0, 0]), 112, 26)).toEqual({ line: "", area: "", last: null });
    expect(sparkline(points([0, 0, 0], [1000, 5, 0]), 112, 26).last).not.toBeNull();
  });
});

describe("pointing at a step", () => {
  const steps = rateSteps(points([0, 0, 0], [1000, 10, 0], [2000, 20, 0], [10_000, 30, 0]));

  it("finds the step nearest in time, which is not the nearest in position when steps are thinned", () => {
    expect(nearestStep(steps, 1100)).toBe(0);
    expect(nearestStep(steps, 1600)).toBe(1);
    expect(nearestStep(steps, 5000)).toBe(1);
    expect(nearestStep(steps, 7000)).toBe(2);
    expect(nearestStep(steps, -50_000)).toBe(0);
    expect(nearestStep([], 5)).toBeNull();
  });

  it("turns a position over the plot into a moment, clamped at both ends", () => {
    const scale = scaleOf(0, 10_000, 100);
    const { left, width, right } = CHART_BOX;
    const inner = width - left - right;
    expect(timeAtX(scale, left)).toBe(0);
    expect(timeAtX(scale, left + inner / 2)).toBe(5000);
    expect(timeAtX(scale, left + inner)).toBe(10_000);
    expect(timeAtX(scale, 0)).toBe(0);
    expect(timeAtX(scale, width + 50)).toBe(10_000);
  });
});

describe("formatClock", () => {
  it("reads a length of time as m:ss, or h:mm:ss from an hour on", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59.9)).toBe("0:59");
    expect(formatClock(75)).toBe("1:15");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(-4)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});

describe("smoothing the transfer", () => {
  const MB = 1_000_000;
  /**
   * A steady upload that reaches the repository in packs: 15 MB every third measurement, nothing
   * in between, one measurement every 5 s. Raw, the speed is 0, 0, 3 MB/s, 0, 0, 3 MB/s ...
   */
  function bursts(count: number): SamplePoint[] {
    return Array.from(
      { length: count },
      (_, index): SamplePoint => [index * 5000, index * 8 * MB, Math.floor(index / 3) * 15 * MB],
    );
  }

  it("averages over 15 seconds, and says so", () => {
    expect(TRANSFER_AVERAGE_MS).toBe(15_000);
    expect(SMOOTHED_SERIES).toEqual({ processed: false, transferred: true });
  });

  it("turns the square wave of packs into a steady line", () => {
    const points = bursts(40);
    const raw = rateSteps(points).map((step) => step.transferred);
    const smooth = smoothedRateSteps(points).map((step) => step.transferred);
    expect(Math.max(...raw)).toBe(3 * MB);
    expect(Math.min(...raw)).toBe(0);
    // From the first full window on, every point is exactly the 1 MB/s the steady upload is.
    for (const value of smooth.slice(3)) {
      expect(value).toBeCloseTo(1 * MB, 3);
    }
    // The first points have less than 15 s behind them and are averaged over what there is.
    expect(smooth[0]).toBe(0);
    expect(smooth[1]).toBe(0);
    expect(smooth[2]).toBeCloseTo((15 * MB) / 15, 3);
  });

  it("is a line you can read: its extremes are close together where the raw ones are far apart", () => {
    const points = bursts(60);
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    const raw = rateSteps(points)
      .slice(10)
      .map((step) => step.transferred);
    const smooth = smoothedRateSteps(points)
      .slice(10)
      .map((step) => step.transferred);
    expect(spread(raw)).toBe(3 * MB);
    expect(spread(smooth)).toBeLessThan(0.001 * MB);
  });

  it("has one entry for every step of the raw rates, at the same moments", () => {
    const points: SamplePoint[] = [
      [0, 0, 0],
      [5000, 10, 100],
      [5000, 10, 100],
      [10_000, 30, 100],
      [20_000, 30, 400],
    ];
    const raw = rateSteps(points);
    const smooth = smoothedRateSteps(points);
    expect(raw).toHaveLength(3);
    expect(smooth.map((step) => step.at)).toEqual(raw.map((step) => step.at));
    // Two measurements at the same moment make no step, in both.
    expect(
      smoothedRateSteps([
        [1000, 0, 0],
        [1000, 5, 5],
      ]),
    ).toEqual([]);
    expect(smoothedRateSteps([[1000, 0, 0]])).toEqual([]);
    expect(smoothedRateSteps([])).toEqual([]);
  });

  it("follows a speed that really changes, a little later than the raw one", () => {
    // 1 MB/s for 60 s, then 4 MB/s: one measurement per 5 s.
    const points: SamplePoint[] = Array.from({ length: 25 }, (_, index): SamplePoint => {
      const seconds = index * 5;
      const bytes = seconds <= 60 ? seconds * MB : 60 * MB + (seconds - 60) * 4 * MB;
      return [seconds * 1000, bytes, bytes];
    });
    const smooth = smoothedRateSteps(points).map((step) => step.transferred);
    // The step to 65 s is the first at 4 MB/s; the window of 15 s still holds 10 s of the old speed.
    expect(smooth[11]).toBeCloseTo(1 * MB, 3); // at 60 s
    expect(smooth[12]).toBeCloseTo((10 * MB + 5 * 4 * MB) / 15, 3); // at 65 s
    expect(smooth[14]).toBeCloseTo(4 * MB, 3); // at 75 s: only the new speed in the window
    expect(smooth[24 - 1]).toBeCloseTo(4 * MB, 3);
  });

  it("counts a counter that went back as standing still instead of as a negative speed", () => {
    const points: SamplePoint[] = [
      [0, 0, 0],
      [5000, 5 * MB, 5 * MB],
      [10_000, 10 * MB, 10 * MB],
      // The run restarted: counters from zero again.
      [15_000, 1 * MB, 1 * MB],
      [20_000, 6 * MB, 6 * MB],
    ];
    const smooth = smoothedRateSteps(points).map((step) => step.transferred);
    for (const value of smooth) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
    // At 20 s the window holds 5 s that moved nothing (the restart) and 5 s that moved 5 MB each
    // way: the 15 s since 5 s hold 5 + 0 + 5 MB.
    expect(smooth[3]).toBeCloseTo((5 * MB + 0 + 5 * MB) / 15, 3);
  });

  it("works on measurements that lie further apart where the history was thinned", () => {
    // Older points are thinned to every 20 s; the window is shorter than a step there.
    const points: SamplePoint[] = [
      [0, 0, 0],
      [20_000, 20 * MB, 20 * MB],
      [40_000, 40 * MB, 40 * MB],
      [45_000, 45 * MB, 45 * MB],
    ];
    const smooth = smoothedRateSteps(points).map((step) => step.transferred);
    for (const value of smooth) {
      expect(value).toBeCloseTo(1 * MB, 3);
    }
  });

  it("is what a chart draws for the transfer, with the processing as it was measured", () => {
    const points = bursts(40);
    const series = chartSeries(points, null);
    const raw = rateSteps(points);
    expect(series.steps).toHaveLength(raw.length);
    expect(series.steps.map((step) => step.processed)).toEqual(raw.map((step) => step.processed));
    expect(series.steps.map((step) => step.transferred)).toEqual(
      smoothedRateSteps(points).map((step) => step.transferred),
    );
    expect(series.from).toBe(0);
    expect(series.to).toBe(39 * 5000);
  });

  it("averages a window on the history behind it, so its first points are not cut short at its edge", () => {
    // 100 measurements, 5 s apart (495 s): the window of a running run is the last 5 minutes.
    const points = bursts(100);
    const series = chartSeries(points, CHART_WINDOW_MS);
    const whole = chartSeries(points, null);
    const first = series.steps[0];
    expect(first).toBeDefined();
    // The same values as in the history, not recomputed from the window's own first point.
    const same = whole.steps.find((step) => step.at === first?.at);
    expect(first?.transferred).toBe(same?.transferred);
    expect(first?.transferred).toBeCloseTo(1 * MB, 3);
    expect(series.from).toBe(windowOf(points, CHART_WINDOW_MS)[0]?.[0]);
    expect(series.to).toBe(99 * 5000);
    expect(series.steps.every((step) => step.at > series.from)).toBe(true);
    expect(chartSeries([], CHART_WINDOW_MS)).toEqual({ steps: [], from: 0, to: 1 });
  });
});
