import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_SIZE_GUARD,
  describeRunSizeHold,
  judgeRunSize,
  median,
  parseRunSizeOverride,
  resolveRunSizeGuard,
  runSizeLimit,
} from "./guard.js";

const GIB = 1024 ** 3;

describe("the run size guard (#99)", () => {
  it("takes the median of the newest runs", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("limits a run to ten times the usual, never below 10 GiB, at least the object's own limit", () => {
    const settings = resolveRunSizeGuard();
    // Usually 2 GiB: up to 20 GiB.
    expect(runSizeLimit(settings, [2 * GIB, 2 * GIB, 3 * GIB, GIB])).toMatchObject({
      limitBytes: 20 * GIB,
      medianBytes: 2 * GIB,
      historyRuns: 4,
      basis: "history",
    });
    // A small object: the floor.
    expect(runSizeLimit(settings, [0, 0, 1024]).limitBytes).toBe(10 * GIB);
    // The object's own limit raises it.
    expect(
      runSizeLimit(resolveRunSizeGuard(null, { limitBytes: 900 * GIB }), [
        2 * GIB,
        2 * GIB,
        2 * GIB,
      ]).limitBytes,
    ).toBe(900 * GIB);
    // Only the newest ten count.
    const history = [...Array(10).fill(GIB), ...Array(10).fill(100 * GIB)];
    expect(runSizeLimit(settings, history).medianBytes).toBe(GIB);
  });

  it("exempts first runs unless a first-run limit is set, and does nothing when off", () => {
    expect(runSizeLimit(resolveRunSizeGuard(), [5 * GIB, 5 * GIB])).toMatchObject({
      limitBytes: null,
      basis: "exempt",
    });
    expect(runSizeLimit(resolveRunSizeGuard({ firstRunBytes: 500 * GIB }), [])).toMatchObject({
      limitBytes: 500 * GIB,
      basis: "first_run",
    });
    expect(
      runSizeLimit(resolveRunSizeGuard(null, { enabled: false }), [GIB, GIB, GIB]),
    ).toMatchObject({ limitBytes: null, basis: "off" });
  });

  it("layers the tenant's settings over the defaults and the object's over the tenant's", () => {
    const resolved = resolveRunSizeGuard({ factor: 5, minFreePercent: 10 }, { factor: 20 });
    expect(resolved).toEqual({ ...DEFAULT_RUN_SIZE_GUARD, factor: 20, minFreePercent: 10 });
    // Stored nonsense is ignored, not trusted.
    expect(
      parseRunSizeOverride({
        factor: 1,
        minBytes: -5,
        minFreePercent: 90,
        enabled: "no",
        limitBytes: null,
      }),
    ).toEqual({ limitBytes: null });
  });

  it("holds the 879 GB recycle bin of an object that usually adds 2 GB", () => {
    const settings = resolveRunSizeGuard();
    const limit = runSizeLimit(settings, [2e9, 2.1e9, 1.9e9, 2e9]);
    const ok = judgeRunSize({ settings, limit, writtenBytes: 15e9, nextBytes: 64e6, space: null });
    expect(ok).toEqual({ hold: false });
    const held = judgeRunSize({
      settings,
      limit,
      writtenBytes: 20e9,
      nextBytes: 64e6,
      space: null,
    });
    expect(held).toMatchObject({ hold: true, reason: "size", limitBytes: 20e9 });
    expect(describeRunSizeHold("fileserver", held as never, limit.medianBytes)).toContain(
      "usually 1.9 GiB",
    );
  });

  it("holds a run that would leave the target less than 2 % free, where the target tells", () => {
    const settings = resolveRunSizeGuard();
    const limit = runSizeLimit(settings, []);
    const space = { freeBytes: 3 * GIB, totalBytes: 100 * GIB };
    expect(judgeRunSize({ settings, limit, writtenBytes: 0, nextBytes: GIB / 2, space })).toEqual({
      hold: false,
    });
    expect(
      judgeRunSize({ settings, limit, writtenBytes: 0, nextBytes: 1.5 * GIB, space }),
    ).toMatchObject({ hold: true, reason: "space", keepBytes: 2 * GIB });
    // 0 % switches the space rule off; so does switching the guard off.
    expect(
      judgeRunSize({
        settings: resolveRunSizeGuard({ minFreePercent: 0 }),
        limit,
        writtenBytes: 0,
        nextBytes: 2.5 * GIB,
        space,
      }),
    ).toEqual({ hold: false });
    const off = resolveRunSizeGuard({ enabled: false });
    expect(
      judgeRunSize({
        settings: off,
        limit: runSizeLimit(off, []),
        writtenBytes: 0,
        nextBytes: 6 * GIB,
        space,
      }),
    ).toEqual({ hold: false });
  });
});
