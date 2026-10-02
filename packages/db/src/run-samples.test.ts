import { describe, expect, it } from "vitest";
import {
  MAX_RUN_SAMPLES,
  MIN_SAMPLE_GAP_MS,
  type RunSamplePoint,
  appendSample,
  compactSamples,
  currentThroughput,
  latestSamples,
  samplePoint,
  sampleRates,
} from "./run-samples.js";

/** `count` points `stepMs` apart, with counters that grow by a fixed amount per step. */
function series(count: number, stepMs = 2000, start = 1_000_000): RunSamplePoint[] {
  return Array.from({ length: count }, (_, index) =>
    samplePoint(start + index * stepMs, index * 1000, index * 100),
  );
}

describe("samplePoint", () => {
  it("keeps whole, non-negative byte counts", () => {
    expect(samplePoint(10.4, 99.6, 3)).toEqual([10, 100, 3]);
    expect(samplePoint(5, -4, Number.NaN)).toEqual([5, 0, 0]);
    expect(samplePoint(5, Number.POSITIVE_INFINITY, 7)).toEqual([5, 0, 7]);
  });
});

describe("appendSample", () => {
  it("starts a history and appends in time order", () => {
    let points: RunSamplePoint[] = [];
    points = appendSample(points, samplePoint(0, 0, 0));
    points = appendSample(points, samplePoint(2000, 10, 1));
    points = appendSample(points, samplePoint(4000, 25, 3));
    expect(points.map((point) => point[0])).toEqual([0, 2000, 4000]);
  });

  it("drops a measurement that is not newer than the last point", () => {
    const points = series(3);
    expect(appendSample(points, samplePoint(points[2]?.[0] ?? 0, 99_999, 9))).toEqual(points);
    expect(appendSample(points, samplePoint(1, 99_999, 9))).toEqual(points);
  });

  it("lets a burst of reports replace the last point instead of filling the history", () => {
    const points = series(3);
    const last = points[2] as RunSamplePoint;
    const burst = samplePoint(last[0] + MIN_SAMPLE_GAP_MS - 1, last[1] + 5, last[2] + 1);
    const next = appendSample(points, burst);
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual(burst);
    // The first two points are untouched; the replaced point carries the newest state.
    expect(next.slice(0, 2)).toEqual(points.slice(0, 2));
  });

  it("appends once the gap is wide enough", () => {
    const points = series(3);
    const last = points[2] as RunSamplePoint;
    const next = appendSample(points, samplePoint(last[0] + MIN_SAMPLE_GAP_MS, last[1], last[2]));
    expect(next).toHaveLength(4);
  });

  it("never exceeds the bound, however long the run", () => {
    let points: RunSamplePoint[] = [];
    for (let index = 0; index < MAX_RUN_SAMPLES * 5; index++) {
      points = appendSample(points, samplePoint(index * 2000, index * 1000, index * 100));
      expect(points.length).toBeLessThanOrEqual(MAX_RUN_SAMPLES);
    }
    expect(points.length).toBeGreaterThan(MAX_RUN_SAMPLES / 2);
  });

  it("keeps the start, the newest stretch at full resolution, and the final state", () => {
    const total = MAX_RUN_SAMPLES * 3;
    let points: RunSamplePoint[] = [];
    for (let index = 0; index < total; index++) {
      points = appendSample(points, samplePoint(index * 2000, index * 1000, index * 100));
    }
    expect(points[0]).toEqual(samplePoint(0, 0, 0));
    expect(points[points.length - 1]).toEqual(
      samplePoint((total - 1) * 2000, (total - 1) * 1000, (total - 1) * 100),
    );
    // The newest 150 points are the real, unthinned ones: two seconds apart.
    const recent = points.slice(-150);
    for (let index = 1; index < recent.length; index++) {
      expect((recent[index]?.[0] ?? 0) - (recent[index - 1]?.[0] ?? 0)).toBe(2000);
    }
    // Time stays strictly increasing across the thinned part.
    for (let index = 1; index < points.length; index++) {
      expect(points[index]?.[0]).toBeGreaterThan(
        points[index - 1]?.[0] ?? Number.POSITIVE_INFINITY,
      );
    }
  });
});

describe("compactSamples", () => {
  it("leaves a history within its bound alone", () => {
    const points = series(10);
    expect(compactSamples(points)).toEqual(points);
  });

  it("thins only the older half and keeps counters cumulative, so volume is not lost", () => {
    const points = series(MAX_RUN_SAMPLES + 1);
    const compacted = compactSamples(points);
    expect(compacted.length).toBeLessThanOrEqual(MAX_RUN_SAMPLES);
    const first = compacted[0] as RunSamplePoint;
    const last = compacted[compacted.length - 1] as RunSamplePoint;
    // The overall growth over the run is exactly what it was.
    expect(last[1] - first[1]).toBe(MAX_RUN_SAMPLES * 1000);
    expect(last[2] - first[2]).toBe(MAX_RUN_SAMPLES * 100);
  });

  it("thins again until a very small bound fits", () => {
    expect(compactSamples(series(50), 8).length).toBeLessThanOrEqual(8);
  });
});

describe("latestSamples", () => {
  it("returns the newest points, or all of them when there are fewer", () => {
    const points = series(10);
    expect(latestSamples(points, 3)).toEqual(points.slice(-3));
    expect(latestSamples(points, 50)).toEqual(points);
  });
});

describe("rates", () => {
  it("derives the rate of every step from neighbouring points", () => {
    const points = [
      samplePoint(0, 0, 0),
      samplePoint(2000, 4000, 200),
      samplePoint(4000, 6000, 600),
    ];
    expect(sampleRates(points)).toEqual([
      { at: 2000, processedBps: 2000, transferredBps: 100 },
      { at: 4000, processedBps: 1000, transferredBps: 200 },
    ]);
  });

  it("counts a counter that went back (a restarted run) as no progress, never as negative speed", () => {
    const points = [samplePoint(0, 9000, 900), samplePoint(2000, 100, 10)];
    expect(sampleRates(points)).toEqual([{ at: 2000, processedBps: 0, transferredBps: 0 }]);
  });

  it("measures the current speed over the newest stretch only", () => {
    const points = [
      samplePoint(0, 0, 0),
      samplePoint(60_000, 6_000_000, 60_000),
      samplePoint(70_000, 6_100_000, 61_000),
      samplePoint(80_000, 6_300_000, 63_000),
    ];
    // 20 s window: from the point at 60 s to the point at 80 s.
    expect(currentThroughput(points, 20_000)).toEqual({
      processedBps: 15_000,
      transferredBps: 150,
    });
  });

  it("has no speed before a second point", () => {
    expect(currentThroughput([])).toBeNull();
    expect(currentThroughput([samplePoint(0, 1, 1)])).toBeNull();
  });
});
