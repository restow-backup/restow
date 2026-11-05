import { describe, expect, it } from "vitest";

import {
  OVERALL_META,
  overallMeta,
  overallRank,
  READINESS_BAR_ORDER,
  READINESS_CATEGORY_META,
  toneOf,
} from "@/components/kit";

import type { BackupDay, EndpointsWidget, RecentJob, StorageGrowthWidget } from "./api.js";
import {
  byteTicks,
  chartsBackupRuns,
  chartsRestoreChecks,
  chartsStorageGrowth,
  dayLabel,
  dedupSaving,
  endpointFindings,
  endpointsOverall,
  isStale,
  jobStatusView,
  lastDays,
  monthLabel,
  previousDays,
  showEndpoints,
  storageChartMax,
  storageChartRows,
  storageHorizonDays,
  successRate,
  successRateDelta,
  tileColumns,
  WidgetUnavailableError,
  widgetView,
} from "./presenters.js";

const day = (date: string, succeeded: number, withItemFailures = 0, failed = 0): BackupDay => ({
  date,
  succeeded,
  withItemFailures,
  failed,
});

describe("which widgets the page shows", () => {
  it("maps a widget result to loading, error or ready", () => {
    expect(widgetView(undefined, true)).toEqual({ kind: "loading" });
    const failed = widgetView({ state: "error" }, false);
    expect(failed.kind).toBe("error");
    expect(failed.kind === "error" && failed.error).toBeInstanceOf(WidgetUnavailableError);
    expect(widgetView({ state: "ok", data: 3 }, false)).toEqual({ kind: "ready", data: 3 });
  });

  it("lays out as many tile columns as there are tiles, at most four", () => {
    expect(tileColumns(5)).toBe(4);
    expect(tileColumns(4)).toBe(4);
    expect(tileColumns(3)).toBe(3);
    expect(tileColumns(2)).toBe(2);
    expect(tileColumns(1)).toBe(2);
  });

  it("leaves out a chart only once its data is there and holds nothing to draw", () => {
    const loading = { kind: "loading" } as const;
    const failed = { kind: "error", error: new WidgetUnavailableError() } as const;
    for (const check of [chartsBackupRuns, chartsRestoreChecks, chartsStorageGrowth]) {
      expect(check(loading)).toBe(true);
      expect(check(failed)).toBe(true);
    }
    const runs = (succeeded: number) => ({
      kind: "ready" as const,
      data: {
        days: 30,
        series: [{ date: "2026-09-01", succeeded, withItemFailures: 0, failed: 0 }],
      },
    });
    expect(chartsBackupRuns(runs(0))).toBe(false);
    expect(chartsBackupRuns(runs(1))).toBe(true);
    const checks = (green: number) => ({
      kind: "ready" as const,
      data: {
        days: 30,
        series: [{ date: "2026-09-01", green, yellow: 0, red: 0 }],
        lastCheckedAt: null,
      },
    });
    expect(chartsRestoreChecks(checks(0))).toBe(false);
    expect(chartsRestoreChecks(checks(2))).toBe(true);
    const stored = (bytes: number) => ({
      kind: "ready" as const,
      data: { days: 30, series: [{ date: "2026-09-01", bytes }], growthBytes: 0, forecast: null },
    });
    expect(chartsStorageGrowth(stored(0))).toBe(false);
    expect(chartsStorageGrowth({ ...stored(0), data: { ...stored(0).data, series: [] } })).toBe(
      false,
    );
    expect(chartsStorageGrowth(stored(10))).toBe(true);
  });
});

describe("backup success", () => {
  const series = [day("d1", 4, 0, 0), day("d2", 3, 1, 0), day("d3", 2, 0, 1), day("d4", 1, 1, 1)];

  it("splits the last window from the one before", () => {
    expect(lastDays(series, 2).map((entry) => entry.date)).toEqual(["d3", "d4"]);
    expect(previousDays(series, 2).map((entry) => entry.date)).toEqual(["d1", "d2"]);
    expect(previousDays(series, 3).map((entry) => entry.date)).toEqual(["d1"]);
  });

  it("never counts runs with failed items as successes", () => {
    expect(successRate([day("d", 3, 1, 0)])).toEqual({ runs: 4, succeeded: 3, rate: 0.75 });
    expect(successRate([])).toEqual({ runs: 0, succeeded: 0, rate: null });
  });

  it("reports the change in percentage points, or nothing without a comparison", () => {
    const current = successRate(lastDays(series, 2));
    const previous = successRate(previousDays(series, 2));
    // 3 of 6 now against 7 of 8 before.
    expect(successRateDelta(current, previous)).toBe(-37.5);
    expect(successRateDelta(current, successRate([]))).toBeNull();
  });
});

describe("tones", () => {
  it("orders the bar worst first and never shows unverified or unrated objects in a success tone", () => {
    expect([...READINESS_BAR_ORDER]).toEqual([
      "red",
      "no_backup",
      "yellow",
      "unverified",
      "green",
      "empty",
    ]);
    const tones = READINESS_BAR_ORDER.map((state) => [
      state,
      toneOf(READINESS_CATEGORY_META[state]),
    ]);
    expect(tones).toEqual([
      ["red", "destructive"],
      ["no_backup", "destructive"],
      ["yellow", "attention"],
      ["unverified", "warning"],
      ["green", "success"],
      ["empty", "muted"],
    ]);
    // Unverified is hatched, so it stays apart from Needs attention without its colour.
    expect(READINESS_CATEGORY_META.unverified.pattern).toBe("hatched");
    expect(READINESS_CATEGORY_META.yellow.pattern).toBe("solid");
  });

  it("rates the aggregate from worst to unknown; its yellow is Not proven in amber", () => {
    expect(toneOf(overallMeta("green"))).toBe("success");
    expect(toneOf(overallMeta("yellow"))).toBe("warning");
    expect(overallMeta("yellow")).toBe(OVERALL_META.yellow);
    expect(toneOf(overallMeta("red"))).toBe("destructive");
    expect(toneOf(overallMeta(null))).toBe("muted");
    const ranks = [
      overallRank("red"),
      overallRank("yellow"),
      overallRank("green"),
      overallRank(null),
    ];
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(new Set(ranks).size).toBe(4);
  });

  it("shows a completed run with failed items and a throttled run honestly", () => {
    const job = (overrides: Partial<RecentJob>): RecentJob => ({
      id: "j",
      queue: "backup",
      status: "completed",
      object: null,
      createdAt: "2026-09-23T10:00:00.000Z",
      startedAt: null,
      completedAt: null,
      progress: { total: 10, done: 10, failed: 0 },
      throttledUntil: null,
      ...overrides,
    });
    // A backup that completed is neutral: green is for proof, and nothing has read it back.
    expect(jobStatusView(job({}))).toEqual({ key: "completed", tone: "neutral", live: false });
    // A restore that completed is the one completed job that is green: the data is back.
    expect(jobStatusView(job({ queue: "restore" }))).toEqual({
      key: "completed",
      tone: "success",
      live: false,
    });
    expect(jobStatusView(job({ queue: "verify" })).tone).toBe("neutral");
    expect(jobStatusView(job({ progress: { total: 10, done: 8, failed: 2 } }))).toEqual({
      key: "completedWithFailures",
      tone: "warning",
      live: false,
    });
    expect(
      jobStatusView(job({ status: "active", throttledUntil: "2026-09-23T10:05:00.000Z" })),
    ).toEqual({ key: "throttled", tone: "warning", live: true });
    expect(jobStatusView(job({ status: "active" })).key).toBe("active");
    expect(jobStatusView(job({ status: "failed" })).tone).toBe("destructive");
    // A backup Graph held back reads held back, in amber, never failed.
    expect(jobStatusView(job({ status: "failed", serviceLimited: true }))).toEqual({
      key: "limited",
      tone: "warning",
      live: false,
    });
  });

  it("calls a backup older than two days stale", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    expect(isStale("2026-09-21T11:00:00.000Z", now)).toBe(true);
    expect(isStale("2026-09-22T12:00:00.000Z", now)).toBe(false);
    expect(isStale(null, now)).toBe(false);
  });
});

describe("storage", () => {
  it("computes the deduplication saving", () => {
    expect(dedupSaving(1000, 250)).toBe(0.75);
    expect(dedupSaving(0, 0)).toBe(0);
    expect(dedupSaving(100, 150)).toBe(0);
  });

  it("joins the measured line and the estimate on the last measured day", () => {
    const widget: StorageGrowthWidget = {
      days: 2,
      series: [
        { date: "2026-09-22", bytes: 100 },
        { date: "2026-09-23", bytes: 200 },
      ],
      growthBytes: 100,
      forecast: {
        method: "linear",
        basisDays: 2,
        slopeBytesPerDay: 100,
        points: [{ date: "2026-09-24", bytes: 300 }],
      },
    };
    expect(storageChartRows(widget)).toEqual([
      { date: "2026-09-22", stored: 100 },
      { date: "2026-09-23", stored: 200, forecast: 200 },
      { date: "2026-09-24", forecast: 300 },
    ]);
    expect(storageChartRows({ ...widget, forecast: null })).toHaveLength(2);
  });

  it("draws the estimate as a band alone from the last measured day on, when there is one", () => {
    const widget: StorageGrowthWidget = {
      days: 90,
      granularity: "week",
      series: [
        { date: "2026-09-20", bytes: 100 },
        { date: "2026-09-23", bytes: 200 },
      ],
      growthBytes: 100,
      forecast: {
        method: "linear",
        basisDays: 90,
        slopeBytesPerDay: 20,
        horizonDays: 14,
        points: [
          { date: "2026-09-30", bytes: 340 },
          { date: "2026-10-07", bytes: 480 },
        ],
        band: {
          slowestBytesPerDay: 10,
          fastestBytesPerDay: 30,
          points: [
            { date: "2026-09-30", low: 270, high: 410 },
            { date: "2026-10-07", low: 340, high: 620 },
          ],
        },
      },
    };
    const rows = storageChartRows(widget);
    expect(rows).toEqual([
      { date: "2026-09-20", stored: 100 },
      { date: "2026-09-23", stored: 200, band: [200, 200] },
      { date: "2026-09-30", band: [270, 410] },
      { date: "2026-10-07", band: [340, 620] },
    ]);
    expect(rows.some((row) => row.forecast !== undefined)).toBe(false);
    expect(storageChartMax(rows)).toBe(620);
    expect(storageHorizonDays(widget)).toBe(14);
    // An older server sends daily points and no horizon.
    expect(
      storageHorizonDays({
        ...widget,
        forecast: widget.forecast && { ...widget.forecast, horizonDays: undefined },
      }),
    ).toBe(2);
  });

  it("labels the months of a year with their year", () => {
    expect(monthLabel("2026-09-30", "en")).toBe("Sep 2026");
    expect(monthLabel("2026-09-30", "de")).toBe("Sept. 2026");
    expect(monthLabel("nope", "en")).toBe("nope");
  });

  it("puts byte ticks on round numbers of the displayed unit", () => {
    const GiB = 1024 ** 3;
    expect(byteTicks(0)).toEqual([0]);
    expect(byteTicks(559 * GiB)).toEqual([0, 200, 400, 600].map((value) => value * GiB));
    expect(byteTicks(4 * GiB)).toEqual([0, 1, 2, 3, 4].map((value) => value * GiB));
    expect(byteTicks(1500)).toEqual([0, 0.5, 1, 1.5].map((value) => value * 1024));
  });

  it("labels a day as the UTC day it is", () => {
    expect(dayLabel("2026-09-23", "en")).toBe("Sep 23");
    expect(dayLabel("2026-09-23", "de")).toBe("23. Sept.");
    expect(dayLabel("not-a-day", "en")).toBe("not-a-day");
  });
});

describe("servers and clients", () => {
  const widget = (overrides: Partial<EndpointsWidget> = {}): EndpointsWidget => ({
    protected: 4,
    machines: 4,
    withoutJob: 0,
    servers: 3,
    clients: 1,
    readiness: { green: 4, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
    notReady: 0,
    failedLastBackup: 0,
    needingAttention: 0,
    otherAttention: 0,
    lastSuccessAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  });
  const none = widget({
    protected: 0,
    machines: 0,
    withoutJob: 0,
    servers: 0,
    clients: 0,
    readiness: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
    lastSuccessAt: null,
  });

  it("shows the card only when the tenant has at least one protected machine", () => {
    expect(showEndpoints({ kind: "ready", data: widget() })).toBe(true);
    expect(showEndpoints({ kind: "ready", data: widget({ protected: 1 }) })).toBe(true);
    // The server answers with zeros for a tenant without endpoints: nothing to show.
    expect(showEndpoints({ kind: "ready", data: none })).toBe(false);
    // Not known yet: no card (a skeleton would flash for most tenants).
    expect(showEndpoints({ kind: "loading" })).toBe(false);
    // Failed: the tenant may have machines, so the card says it could not be loaded.
    expect(showEndpoints({ kind: "error", error: new WidgetUnavailableError() })).toBe(true);
  });

  it("rates the machines by the aggregate rule of the readiness card", () => {
    expect(endpointsOverall(none)).toBeNull();
    expect(endpointsOverall(widget())).toBe("green");
    // Not restorable or no backup yet is red, like for the objects.
    expect(
      endpointsOverall(
        widget({ readiness: { green: 3, yellow: 0, red: 1, unverified: 0, noBackup: 0 } }),
      ),
    ).toBe("red");
    expect(
      endpointsOverall(
        widget({ readiness: { green: 3, yellow: 0, red: 0, unverified: 0, noBackup: 1 } }),
      ),
    ).toBe("red");
    // A backup no restore test has read back is not proven: yellow, no longer red.
    expect(
      endpointsOverall(
        widget({
          readiness: { green: 3, yellow: 0, red: 0, unverified: 1, noBackup: 0 },
          notReady: 1,
        }),
      ),
    ).toBe("yellow");
    // A backup proven with gaps needs attention: yellow (Not proven).
    expect(
      endpointsOverall(
        widget({ readiness: { green: 3, yellow: 1, red: 0, unverified: 0, noBackup: 0 } }),
      ),
    ).toBe("yellow");
    // UI rework decision 2: a failed last backup, a silent machine or one in no job are findings
    // of their own; they no longer turn the badge yellow.
    expect(endpointsOverall(widget({ failedLastBackup: 1 }))).toBe("green");
    expect(endpointsOverall(widget({ needingAttention: 2 }))).toBe("green");
    expect(endpointsOverall(widget({ withoutJob: 1, needingAttention: 1 }))).toBe("green");
    // `notReady` is a count, not the rule: the categories decide.
    expect(
      endpointsOverall(
        widget({
          readiness: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
          notReady: 1,
        }),
      ),
    ).toBeNull();
    // The worst wins.
    expect(
      endpointsOverall(
        widget({
          readiness: { green: 1, yellow: 1, red: 0, unverified: 1, noBackup: 1 },
          failedLastBackup: 1,
        }),
      ),
    ).toBe("red");
  });

  it("lists what needs an admin, worst first, and leaves out what is fine", () => {
    expect(endpointFindings(widget())).toEqual([]);
    expect(
      endpointFindings(
        widget({
          readiness: { green: 0, yellow: 0, red: 2, unverified: 4, noBackup: 1 },
          notReady: 7,
          failedLastBackup: 1,
          withoutJob: 1,
          needingAttention: 4,
          otherAttention: 3,
        }),
      ),
    ).toEqual([
      { key: "notRestorable", count: 3, tone: "destructive" },
      { key: "failedLastBackup", count: 1, tone: "destructive" },
      { key: "unverified", count: 4, tone: "warning" },
      { key: "withoutJob", count: 1, tone: "attention" },
      { key: "attention", count: 3, tone: "attention" },
    ]);
    expect(endpointFindings(widget({ needingAttention: 1, otherAttention: 1 }))).toEqual([
      { key: "attention", count: 1, tone: "attention" },
    ]);
  });
});
