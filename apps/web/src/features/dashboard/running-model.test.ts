import { describe, expect, it } from "vitest";

import type { PveRunning } from "@/features/history/api";
import { iso, run, samples, subject, T0 } from "@/features/history/fixtures";

import {
  currentBps,
  currentTotal,
  elapsedMs,
  HOLD_MS,
  itemFromPve,
  itemFromRun,
  itemsOf,
  limitPve,
  mergePoints,
  pointsFromSamples,
  RateHistory,
  type RatePoint,
  type RunningItem,
  sortRunning,
  sparkPath,
  summarizeTotal,
  totalBytes,
  totalSeries,
  valueAt,
} from "./running-model.js";

function pve(overrides: Partial<PveRunning> = {}): PveRunning {
  return {
    id: "pve-1",
    kind: "backup",
    guest: { id: "guest-1", vmid: 100, name: "web01", kind: "vm" },
    jobName: "Every guest",
    startedAt: iso(0),
    cancelling: false,
    progress: {
      bytesDone: 3_000,
      bytesTotal: 12_000,
      bytesUploaded: 100,
      bytesPerSecond: 500,
      at: iso(30),
    },
    ...overrides,
  };
}

function item(overrides: Partial<RunningItem> = {}): RunningItem {
  return { ...(itemFromRun(run()) as RunningItem), ...overrides };
}

describe("which runs belong in the widget", () => {
  it("takes a run that goes on, with what it knows about itself", () => {
    const result = itemFromRun(run());
    expect(result).toMatchObject({
      key: `mail:${run().id}`,
      source: "mail",
      object: "mailbox",
      category: "backup",
      name: "anna@contoso.example",
      jobName: "Mail backup",
      startedAt: Date.parse(iso(0)),
      itemsDone: 400,
      itemsTotal: 1000,
      bytesDone: 320_000_000,
      percent: 40,
      bps: 4_000_000,
      cancelling: false,
      throttled: false,
      link: { kind: "run", id: run().id },
    });
    expect(result?.samples).toHaveLength(30);
  });

  it("leaves out runs that wait or ended, and kinds the widget is not about", () => {
    expect(itemFromRun(run({ state: "queued" }))).toBeNull();
    expect(itemFromRun(run({ state: "succeeded" }))).toBeNull();
    expect(itemFromRun(run({ state: "failed" }))).toBeNull();
    expect(itemFromRun(run({ kind: "export" }))).toBeNull();
    expect(itemFromRun(run({ kind: "maintenance" }))).toBeNull();
  });

  it("keeps restores and restore checks, as their own categories", () => {
    expect(itemFromRun(run({ kind: "restore" }))?.category).toBe("restore");
    expect(itemFromRun(run({ kind: "restore_check" }))?.category).toBe("check");
  });

  it("knows a run of a whole tenant (no object), a throttled run and one that is stopping", () => {
    const whole = itemFromRun(run({ subject: null, cancelling: true }));
    expect(whole).toMatchObject({ object: null, name: null, cancelling: true });
    expect(
      itemFromRun(run({ throttle: { until: iso(60), reason: "graph" } as never }))?.throttled,
    ).toBe(true);
  });

  it("names a machine and a file share by their own kind, and carries the tenant", () => {
    expect(
      itemFromRun(run({ source: "endpoint", subject: subject("server", "web01") }), {
        id: "t1",
        name: "Müller GmbH",
      }),
    ).toMatchObject({ object: "server", tenant: { id: "t1", name: "Müller GmbH" } });
    expect(
      itemFromRun(run({ source: "file_share", subject: subject("file_share", "Projekte") }))
        ?.object,
    ).toBe("file_share");
  });

  it("makes an item of a Proxmox VE guest's run, with its percent from the node's figures", () => {
    expect(itemFromPve(pve())).toMatchObject({
      key: "pve:pve-1",
      source: "pve",
      object: "vm",
      category: "backup",
      name: "web01",
      detail: "VMID 100",
      jobName: "Every guest",
      bytesDone: 3_000,
      bytesTotal: 12_000,
      percent: 25,
      bps: 500,
      reportedAt: Date.parse(iso(30)),
      samples: null,
      link: { kind: "guest", id: "guest-1" },
    });
  });

  it("falls back to the VMID for a guest without a name, and to no percent without a total", () => {
    const bare = itemFromPve(
      pve({
        guest: { id: "g", vmid: 205, name: null, kind: "ct" },
        progress: null,
        kind: "boot_test",
      }),
    );
    expect(bare).toMatchObject({
      name: "205",
      detail: null,
      object: "ct",
      category: "check",
      percent: null,
      bytesDone: null,
      bps: null,
    });
    expect(
      itemFromPve(
        pve({
          progress: {
            bytesDone: 10,
            bytesTotal: null,
            bytesUploaded: null,
            bytesPerSecond: null,
            at: iso(1),
          },
        }),
      ).percent,
    ).toBeNull();
  });

  it("combines runs of every kind and orders them by how long they go on", () => {
    const items = itemsOf(
      [
        run({ id: "late", startedAt: iso(120), subject: subject("mailbox", "late") }),
        run({ id: "early", startedAt: iso(0), subject: subject("onedrive", "early") }),
        run({ id: "done", state: "succeeded" }),
      ],
      [pve({ startedAt: iso(60) })],
    );
    expect(items.map((entry) => entry.name)).toEqual(["early", "web01", "late"]);
  });

  it("orders by tenant first on the view of all tenants, and is stable for equal starts", () => {
    const a = item({ key: "a", name: "same", startedAt: 1, tenant: { id: "2", name: "Zeta" } });
    const b = item({ key: "b", name: "same", startedAt: 1, tenant: { id: "1", name: "Alpha" } });
    const c = item({ key: "c", name: "same", startedAt: 1, tenant: { id: "1", name: "Alpha" } });
    expect(sortRunning([a, c, b]).map((entry) => entry.key)).toEqual(["b", "c", "a"]);
  });

  it("measures how long a run goes on, never negative, nothing without a start", () => {
    expect(elapsedMs({ startedAt: 1000 }, 4000)).toBe(3000);
    expect(elapsedMs({ startedAt: 5000 }, 4000)).toBe(0);
    expect(elapsedMs({ startedAt: null }, 4000)).toBeNull();
  });
});

describe("the figures over all runs", () => {
  it("adds the speeds of the runs that say theirs, and is unknown when none does", () => {
    const now = Date.parse(iso(30));
    expect(currentTotal([item({ bps: 100 }), item({ bps: 250 }), item({ bps: null })], now)).toBe(
      350,
    );
    expect(currentTotal([item({ bps: null })], now)).toBeNull();
    expect(currentTotal([], now)).toBeNull();
  });

  it("counts the speed of a node only while it reports", () => {
    const guest = itemFromPve(pve());
    const reported = Date.parse(iso(30));
    expect(currentBps(guest, reported + HOLD_MS)).toBe(500);
    // The node went quiet; its run is still "running", but the speed is no speed any more.
    expect(currentBps(guest, reported + HOLD_MS + 1)).toBeNull();
    expect(currentTotal([guest, item({ bps: 100 })], reported + HOLD_MS + 1)).toBe(100);
    expect(currentTotal([guest], reported + HOLD_MS + 1)).toBeNull();
    // A run that does not say when keeps its figure.
    expect(currentBps(item({ bps: 7 }), reported + 10 * HOLD_MS)).toBe(7);
  });

  it("adds the bytes read, where each knows", () => {
    expect(
      totalBytes([item({ bytesDone: 10 }), item({ bytesDone: null }), item({ bytesDone: 5 })]),
    ).toBe(15);
  });

  it("summarizes a series by its last value, its mean and its peak", () => {
    const points: RatePoint[] = [
      { at: 1, bps: 10 },
      { at: 2, bps: 30 },
      { at: 3, bps: 20 },
    ];
    expect(summarizeTotal(points)).toEqual({ current: 20, average: 20, peak: 30 });
    expect(summarizeTotal([])).toEqual({ current: 0, average: 0, peak: 0 });
  });
});

describe("the speed of one run over time", () => {
  it("reads the speed of every step from the measurements", () => {
    const points = pointsFromSamples(samples(4, { processedPerStep: 8_000_000, start: T0 }));
    expect(points).toHaveLength(3);
    // 8 MB every two seconds.
    expect(points.every((point) => point.bps === 4_000_000)).toBe(true);
    expect(points[0]?.at).toBe(T0 + 2000);
  });

  it("lets newer points replace what they cover and keeps what is older", () => {
    const older: RatePoint[] = [
      { at: 1000, bps: 1 },
      { at: 2000, bps: 2 },
      { at: 3000, bps: 3 },
    ];
    const fresh: RatePoint[] = [
      { at: 3000, bps: 30 },
      { at: 4000, bps: 40 },
    ];
    expect(mergePoints(older, fresh).map((point) => point.bps)).toEqual([1, 2, 30, 40]);
    expect(mergePoints(older, [])).toEqual(older);
  });

  it("holds a run's last speed for a while, then counts it as stopped", () => {
    const points: RatePoint[] = [
      { at: 1000, bps: 10 },
      { at: 5000, bps: 20 },
    ];
    expect(valueAt(points, 500)).toBe(0);
    expect(valueAt(points, 3000)).toBe(10);
    expect(valueAt(points, 5000)).toBe(20);
    expect(valueAt(points, 5000 + HOLD_MS)).toBe(20);
    expect(valueAt(points, 5000 + HOLD_MS + 1)).toBe(0);
  });
});

describe("RateHistory", () => {
  /** A Proxmox VE run whose node reported at `reportedAt` (epoch ms). */
  function guestReporting(
    reportedAt: number,
    figures: { bytesDone?: number; bytesPerSecond?: number | null } = {},
  ): RunningItem {
    return itemFromPve(
      pve({
        progress: {
          bytesDone: figures.bytesDone ?? 1000,
          bytesTotal: null,
          bytesUploaded: null,
          bytesPerSecond: figures.bytesPerSecond === undefined ? 100 : figures.bytesPerSecond,
          at: new Date(reportedAt).toISOString(),
        },
      }),
    );
  }

  it("takes the speed of a run with measurements from them, whether or not the state is current", () => {
    const history = new RateHistory();
    const withSamples = item({ samples: samples(5), bps: 1 });
    history.sample(withSamples, T0 + 10_000, false);
    expect(history.points(withSamples.key)).toHaveLength(4);
  });

  it("samples a run without measurements: its reported speed, else the growth of its bytes", () => {
    const history = new RateHistory();
    const first = guestReporting(T0, { bytesDone: 1000, bytesPerSecond: null });
    history.sample(first, T0 + 1000);
    // Nothing to compare with yet: no speed.
    expect(history.points(first.key)).toEqual([]);
    // 5000 bytes in the 5 s between the node's reports.
    history.sample(guestReporting(T0 + 5000, { bytesDone: 6000, bytesPerSecond: null }), T0 + 6000);
    expect(history.points(first.key)).toEqual([{ at: T0 + 5000, bps: 1000 }]);
    // A speed the node reported wins over the difference.
    history.sample(guestReporting(T0 + 9000, { bytesDone: 6100, bytesPerSecond: 42 }), T0 + 9500);
    expect(history.points(first.key).at(-1)).toEqual({ at: T0 + 9000, bps: 42 });
  });

  it("draws no line that never was while the state is not current", () => {
    const history = new RateHistory();
    const guest = guestReporting(T0);
    history.sample(guest, T0 + 1000, false);
    expect(history.points(guest.key)).toEqual([]);
  });

  it("adds a point for a report that is new, not for every look at the same one", () => {
    const history = new RateHistory();
    const report = guestReporting(T0);
    // The page looks every 3 s, the node reports every 4 s (and "All tenants" asks every 10 s).
    for (const looked of [1000, 4000, 7000]) {
      history.sample(report, T0 + looked);
    }
    expect(history.points(report.key)).toEqual([{ at: T0, bps: 100 }]);
    history.sample(guestReporting(T0 + 8000, { bytesPerSecond: 120 }), T0 + 10_000);
    expect(history.points(report.key)).toEqual([
      { at: T0, bps: 100 },
      { at: T0 + 8000, bps: 120 },
    ]);
  });

  it("dates the speed from the bytes by the reports, so a slow report is no spike", () => {
    const history = new RateHistory();
    const key = guestReporting(T0).key;
    const at = (reported: number, bytesDone: number) =>
      guestReporting(T0 + reported, { bytesDone, bytesPerSecond: null });
    history.sample(at(0, 0), T0 + 1000);
    // 4 s apart, 4000 bytes: 1000 B/s, however often the page looks in between.
    for (const looked of [4500, 7500]) {
      history.sample(at(4000, 4000), T0 + looked);
    }
    history.sample(at(8000, 8000), T0 + 10_500);
    expect(history.points(key)).toEqual([
      { at: T0 + 4000, bps: 1000 },
      { at: T0 + 8000, bps: 1000 },
    ]);
  });

  it("does not turn bytes that did not move into zeros and spikes where no time is told", () => {
    const history = new RateHistory();
    const run = item({ samples: null, bps: null, bytesDone: 0 });
    history.sample(run, 3000);
    // The figure arrives every 9 s; the page looks every 3 s.
    history.sample({ ...run, bytesDone: 0 }, 6000);
    history.sample({ ...run, bytesDone: 0 }, 9000);
    expect(history.points(run.key)).toEqual([]);
    history.sample({ ...run, bytesDone: 9000 }, 12_000);
    // The growth over the time since the figure last changed, not over one beat.
    expect(history.points(run.key)).toEqual([{ at: 12_000, bps: 1000 }]);
    history.sample({ ...run, bytesDone: 9000 }, 15_000);
    expect(history.points(run.key)).toHaveLength(1);
  });

  it("adds no point for a node that went quiet", () => {
    const history = new RateHistory();
    const silent = guestReporting(T0);
    history.sample(silent, T0 + HOLD_MS + 1000);
    expect(history.points(silent.key)).toEqual([]);
    expect(history.all()).toEqual([]);
    // It reported lately enough: that one counts.
    history.sample(silent, T0 + HOLD_MS);
    expect(history.points(silent.key)).toEqual([{ at: T0, bps: 100 }]);
    // The run goes on without new reports: the total sees the speed end instead of repeating it.
    for (let looked = T0 + HOLD_MS + 3000; looked <= T0 + 60_000; looked += 3000) {
      history.sample(silent, looked);
    }
    expect(history.points(silent.key)).toHaveLength(1);
    const total = totalSeries(history.all(), T0 + 60_000, 60_000, 5000);
    expect(total.at(-1)?.bps).toBe(0);
  });

  it("does not take a bytes counter that went back as negative speed", () => {
    const history = new RateHistory();
    const base = item({ samples: null, bps: null, bytesDone: 5000 });
    history.sample(base, 1000);
    history.sample({ ...base, bytesDone: 100 }, 3000);
    expect(history.points(base.key)).toEqual([{ at: 3000, bps: 0 }]);
  });

  it("does not date a point later than the page looked, whatever a clock says", () => {
    const history = new RateHistory();
    const ahead = guestReporting(T0 + 5000);
    history.sample(ahead, T0 + 1000);
    expect(history.points(ahead.key)).toEqual([{ at: T0 + 1000, bps: 100 }]);
  });

  it("forgets points older than the window, and a run with none left", () => {
    const history = new RateHistory(60_000);
    const guest = guestReporting(T0 + 10_000);
    history.sample(guest, T0 + 10_000);
    history.sample(guestReporting(T0 + 40_000), T0 + 40_000);
    history.prune(T0 + 75_000);
    expect(history.points(guest.key).map((point) => point.at)).toEqual([T0 + 40_000]);
    history.prune(T0 + 200_000);
    expect(history.points(guest.key)).toEqual([]);
    expect(history.all()).toEqual([]);
  });

  it("keeps a run that ended in the total until it ages out", () => {
    const history = new RateHistory(300_000);
    const first = itemFromPve(pve({ id: "a" }));
    const second = itemFromPve(pve({ id: "b" }));
    // Every look brings a new report from both nodes.
    const report = (base: RunningItem, bps: number, at: number): RunningItem => ({
      ...base,
      bps,
      reportedAt: at,
    });
    for (const at of [10_000, 13_000, 16_000]) {
      history.sample(report(first, 100, at), at);
      history.sample(report(second, 50, at), at);
    }
    // The first run ends; only the second goes on to be sampled.
    for (let at = 19_000; at <= 40_000; at += 3000) {
      history.sample(report(second, 50, at), at);
    }
    const total = totalSeries(history.all(), 40_000, 30_000, 5000);
    const at = (moment: number) => total.find((point) => point.at === moment)?.bps;
    expect(at(15_000)).toBe(150);
    // After the hold the first run counts no more, but the past stays as it was.
    expect(at(40_000)).toBe(50);
    expect(at(15_000)).toBe(150);
  });

  it("starts over on clear", () => {
    const history = new RateHistory();
    history.sample(guestReporting(T0), T0 + 1000);
    history.clear();
    expect(history.all()).toEqual([]);
    // The same report counts again for a new history.
    history.sample(guestReporting(T0), T0 + 1000);
    expect(history.all()).toHaveLength(1);
  });
});

describe("the Proxmox VE runs the page lists", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      pve({ id: `run-${String(index).padStart(3, "0")}`, startedAt: iso(index) }),
    );

  it("lists them all up to the limit, and says nothing is left out", () => {
    const result = limitPve(many(50));
    expect(result.runs).toHaveLength(50);
    expect(result.truncated).toBe(false);
  });

  it("drops the oldest beyond the limit and says some are left out", () => {
    const result = limitPve(many(51));
    expect(result.runs).toHaveLength(50);
    expect(result.truncated).toBe(true);
    // The oldest start is the one that does not fit.
    expect(result.runs.some((run) => run.id === "run-000")).toBe(false);
    expect(result.runs.some((run) => run.id === "run-050")).toBe(true);
  });
});

describe("the total over time", () => {
  it("has one point per step up to now and adds the runs that count at that moment", () => {
    const a: RatePoint[] = [
      { at: 1000, bps: 10 },
      { at: 6000, bps: 10 },
    ];
    const b: RatePoint[] = [{ at: 6000, bps: 5 }];
    const total = totalSeries([a, b], 11_000, 10_000, 5000);
    expect(total.map((point) => point.at)).toEqual([1000, 6000, 11_000]);
    expect(total.map((point) => point.bps)).toEqual([10, 15, 15]);
  });

  it("always ends at now, even when the window is no multiple of the step", () => {
    const total = totalSeries([[{ at: 100, bps: 7 }]], 1000, 900, 400);
    expect(total.at(-1)).toEqual({ at: 1000, bps: 7 });
    expect(total[0]?.at).toBe(100);
  });

  it("is zero everywhere without runs", () => {
    expect(totalSeries([], 60_000, 20_000, 5000).every((point) => point.bps === 0)).toBe(true);
  });
});

describe("the small line", () => {
  it("is empty without points in the window", () => {
    expect(sparkPath([], 100, 20, 0, 1000)).toEqual({ line: "", area: "", last: null });
    expect(sparkPath([{ at: 5000, bps: 1 }], 100, 20, 0, 1000).last).toBeNull();
  });

  it("puts the newest point at the right and the peak near the top", () => {
    const path = sparkPath(
      [
        { at: 0, bps: 10 },
        { at: 500, bps: 100 },
        { at: 1000, bps: 50 },
      ],
      100,
      20,
      0,
      1000,
    );
    const coordinates = path.line
      .split(" ")
      .map((pair) => pair.split(",").map(Number) as [number, number]);
    expect(coordinates).toHaveLength(3);
    expect(coordinates[0]?.[0]).toBeCloseTo(1, 0);
    expect(coordinates[2]?.[0]).toBeCloseTo(99, 0);
    // y grows downwards: the peak is the highest point.
    expect(Math.min(...coordinates.map(([, y]) => y))).toBe(coordinates[1]?.[1]);
    expect(path.last).toEqual({ x: coordinates[2]?.[0], y: coordinates[2]?.[1] });
    expect(path.area.startsWith(`${coordinates[0]?.[0]},20 `)).toBe(true);
  });

  it("scales to the run's own peak, so a slow run is drawn as tall as a fast one", () => {
    const slow = sparkPath(
      [
        { at: 0, bps: 2 },
        { at: 1000, bps: 1 },
      ],
      100,
      20,
      0,
      1000,
    );
    const fast = sparkPath(
      [
        { at: 0, bps: 2000 },
        { at: 1000, bps: 1000 },
      ],
      100,
      20,
      0,
      1000,
    );
    expect(slow.line).toBe(fast.line);
  });
});
