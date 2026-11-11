import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_SIZE_GUARD,
  DEFAULT_RUN_SPACE_RULE,
  describeRunSizeHold,
  judgeRunSize,
  keepFreeBytes,
  median,
  parseRunSizeOverride,
  parseRunSpaceOverride,
  resolveRunSizeGuard,
  resolveRunSpaceRule,
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
    const resolved = resolveRunSizeGuard({ factor: 5 }, { factor: 20 });
    expect(resolved).toEqual({ ...DEFAULT_RUN_SIZE_GUARD, factor: 20 });
    // Stored nonsense is ignored, not trusted; a space setting is no object setting any more.
    expect(
      parseRunSizeOverride({
        factor: 1,
        minBytes: -5,
        minFreePercent: 2,
        enabled: "no",
        limitBytes: null,
      }),
    ).toEqual({ limitBytes: null });
  });

  it("holds the 879 GB recycle bin of an object that usually adds 2 GB", () => {
    const settings = resolveRunSizeGuard();
    const limit = runSizeLimit(settings, [2e9, 2.1e9, 1.9e9, 2e9]);
    const ok = judgeRunSize({
      settings,
      limit,
      writtenBytes: 15e9,
      nextBytes: 64e6,
      space: null,
      keepBytes: null,
    });
    expect(ok).toEqual({ hold: false });
    const held = judgeRunSize({
      settings,
      limit,
      writtenBytes: 20e9,
      nextBytes: 64e6,
      space: null,
      keepBytes: null,
    });
    expect(held).toMatchObject({ hold: true, reason: "size", limitBytes: 20e9 });
    expect(describeRunSizeHold("fileserver", held as never, limit.medianBytes)).toContain(
      "usually 1.9 GiB",
    );
  });

  it("keeps 5 % of a target free, at least 20 GiB, at most 500 GiB, never more than a quarter", () => {
    const rule = DEFAULT_RUN_SPACE_RULE;
    const keep = (totalBytes: number) => keepFreeBytes(rule, { freeBytes: 0, totalBytes });
    expect(keep(2048 * GIB)).toBe(Math.ceil(102.4 * GIB));
    // Small: the minimum (2 % of 2 TB would have been 40 GB, 5 % of 200 GB is 10 GB).
    expect(keep(200 * GIB)).toBe(20 * GIB);
    // Large: the maximum (5 % of 200 TB would be 10 TB).
    expect(keep(200 * 1024 * GIB)).toBe(500 * GIB);
    // A small disk never keeps more than a quarter free.
    expect(keep(40 * GIB)).toBe(10 * GIB);
    // No size reported: the minimum. Off: none.
    expect(keepFreeBytes(rule, { freeBytes: 5 * GIB, totalBytes: 0 })).toBe(20 * GIB);
    expect(keepFreeBytes(rule, null)).toBe(20 * GIB);
    expect(
      keepFreeBytes({ ...rule, enabled: false }, { freeBytes: 0, totalBytes: GIB }),
    ).toBeNull();
  });

  it("takes the space rule from the installation, the tenant (own targets only) and the target", () => {
    const installation = { percent: 3 };
    const tenant = { minBytes: 50 * GIB };
    const target = { maxBytes: 100 * GIB };
    expect(resolveRunSpaceRule({ installation, tenant, target, sharedTarget: false })).toEqual({
      enabled: true,
      percent: 3,
      minBytes: 50 * GIB,
      maxBytes: 100 * GIB,
    });
    // The installation's default target is shared: only the installation decides there.
    expect(resolveRunSpaceRule({ installation, tenant, target, sharedTarget: true })).toEqual({
      ...DEFAULT_RUN_SPACE_RULE,
      percent: 3,
    });
    expect(parseRunSpaceOverride({ percent: 80, minBytes: -1, enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("holds a run that would leave the target less free than it keeps", () => {
    const settings = resolveRunSizeGuard();
    const limit = runSizeLimit(settings, []);
    const space = { freeBytes: 21 * GIB, totalBytes: 100 * GIB };
    const keepBytes = keepFreeBytes(DEFAULT_RUN_SPACE_RULE, space);
    expect(
      judgeRunSize({ settings, limit, writtenBytes: 0, nextBytes: GIB / 2, space, keepBytes }),
    ).toEqual({ hold: false });
    expect(
      judgeRunSize({ settings, limit, writtenBytes: 0, nextBytes: 1.5 * GIB, space, keepBytes }),
    ).toMatchObject({ hold: true, reason: "space", keepBytes: 20 * GIB });
    // The rule off (null): never held for space.
    expect(
      judgeRunSize({
        settings,
        limit,
        writtenBytes: 0,
        nextBytes: 30 * GIB,
        space,
        keepBytes: null,
      }),
    ).toEqual({ hold: false });
  });
});
