import { describe, expect, it } from "vitest";

import type {
  BackupDay,
  EndpointsWidget,
  ReadinessWidget,
  RecentJob,
  StorageGrowthWidget,
} from "./api.js";
import {
  WidgetUnavailableError,
  byteTicks,
  dayLabel,
  dedupSaving,
  endpointFindings,
  endpointsOverall,
  isStale,
  jobStatusView,
  lastDays,
  previousDays,
  readinessRank,
  readinessSegments,
  readinessTone,
  showEndpoints,
  storageChartRows,
  successRate,
  successRateDelta,
  tileColumns,
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

  it("lays out as many tile columns as there are tiles", () => {
    expect(tileColumns(4)).toBe("sm:grid-cols-2 xl:grid-cols-4");
    expect(tileColumns(3)).toBe("sm:grid-cols-2 xl:grid-cols-3");
    expect(tileColumns(2)).toBe("sm:grid-cols-2");
    expect(tileColumns(1)).toBe("");
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
  it("never shows unverified or unrated objects in a success tone", () => {
    const readiness: ReadinessWidget = {
      overall: "red",
      total: 10,
      green: 5,
      yellow: 1,
      red: 1,
      unverified: 2,
      noBackup: 1,
      overdue: 0,
      withoutJob: 0,
      running: 0,
      lastCheckedAt: null,
    };
    const segments = readinessSegments(readiness);
    expect(segments.map((segment) => segment.key)).toEqual([
      "red",
      "noBackup",
      "unverified",
      "yellow",
      "green",
    ]);
    const unverified = segments.find((segment) => segment.key === "unverified");
    expect(unverified?.tone).toBe("warning");
    expect(segments.filter((segment) => segment.tone === "success").map((s) => s.key)).toEqual([
      "green",
    ]);
    expect(readinessSegments({ ...readiness, unverified: 0 }).map((s) => s.key)).not.toContain(
      "unverified",
    );
  });

  it("rates readiness from worst to unknown", () => {
    expect(readinessTone("green")).toBe("success");
    expect(readinessTone("yellow")).toBe("warning");
    expect(readinessTone("red")).toBe("destructive");
    expect(readinessTone(null)).toBe("muted");
    expect([
      readinessRank("red"),
      readinessRank("yellow"),
      readinessRank("green"),
      readinessRank(null),
    ]).toEqual([0, 1, 2, 3]);
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

  it("rates the machines by the rules of the readiness card", () => {
    expect(endpointsOverall(none)).toBeNull();
    expect(endpointsOverall(widget())).toBe("green");
    // Not proven restorable in any way is red, like for the objects.
    expect(endpointsOverall(widget({ notReady: 1 }))).toBe("red");
    expect(
      endpointsOverall(
        widget({
          readiness: { green: 3, yellow: 0, red: 0, unverified: 1, noBackup: 0 },
          notReady: 1,
        }),
      ),
    ).toBe("red");
    // A backup proven with gaps, a failed last backup or a silent machine ask for a look.
    expect(
      endpointsOverall(
        widget({ readiness: { green: 3, yellow: 1, red: 0, unverified: 0, noBackup: 0 } }),
      ),
    ).toBe("yellow");
    expect(endpointsOverall(widget({ failedLastBackup: 1 }))).toBe("yellow");
    expect(endpointsOverall(widget({ needingAttention: 2 }))).toBe("yellow");
    // The worst wins.
    expect(endpointsOverall(widget({ notReady: 1, failedLastBackup: 1 }))).toBe("red");
  });

  it("lists what needs an admin, worst first, and leaves out what is fine", () => {
    expect(endpointFindings(widget())).toEqual([]);
    expect(
      endpointFindings(
        widget({
          notReady: 3,
          failedLastBackup: 1,
          withoutJob: 1,
          needingAttention: 4,
          otherAttention: 3,
        }),
      ),
    ).toEqual([
      { key: "notReady", count: 3, tone: "destructive" },
      { key: "failedLastBackup", count: 1, tone: "destructive" },
      { key: "withoutJob", count: 1, tone: "warning" },
      { key: "attention", count: 3, tone: "warning" },
    ]);
    // A machine in no job alone keeps the fleet from green.
    expect(endpointsOverall(widget({ withoutJob: 1, needingAttention: 1 }))).toBe("yellow");
    expect(endpointFindings(widget({ needingAttention: 1, otherAttention: 1 }))).toEqual([
      { key: "attention", count: 1, tone: "warning" },
    ]);
  });

  it("segments the machines like the readiness card: unproven ones never in a success tone", () => {
    const segments = readinessSegments(
      widget({ readiness: { green: 2, yellow: 1, red: 1, unverified: 1, noBackup: 1 } }).readiness,
    );
    expect(segments.map((segment) => [segment.key, segment.tone])).toEqual([
      ["red", "destructive"],
      ["noBackup", "destructive"],
      ["unverified", "warning"],
      ["yellow", "warning"],
      ["green", "success"],
    ]);
  });
});
