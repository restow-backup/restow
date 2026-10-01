import { describe, expect, it } from "vitest";

import {
  KPI_NAMES,
  MISSING_REASON,
  type StatsParams,
  normalizeStats,
  statsCsvPath,
  statsPath,
  statsPdfPath,
  statsQueryString,
} from "./api.js";
import { csvDownload, pdfDownload } from "./exports.js";
import { resolvePeriod } from "./period.js";

const TENANT: StatsParams = {
  from: "2026-09-17",
  to: "2026-09-23",
  granularity: "day",
  scope: "tenant",
};
const PROVIDER: StatsParams = { ...TENANT, scope: "provider" };

const RANGE = "from=2026-09-17&to=2026-09-23";

describe("statsQueryString", () => {
  it("writes period and granularity in a fixed order", () => {
    expect(statsQueryString(TENANT)).toBe(`?${RANGE}&granularity=day`);
  });

  it("writes the scope only for the provider scope", () => {
    expect(statsQueryString(PROVIDER)).toBe(`?${RANGE}&granularity=day&scope=provider`);
    expect(statsQueryString(TENANT)).not.toContain("scope");
  });

  it("puts the dataset first and the language last", () => {
    expect(statsQueryString(PROVIDER, { dataset: "failuresByCause", lang: "de" })).toBe(
      `?dataset=failuresByCause&${RANGE}&granularity=day&scope=provider&lang=de`,
    );
  });

  it("builds the three endpoint paths", () => {
    expect(statsPath(TENANT)).toBe(`/stats?${RANGE}&granularity=day`);
    expect(statsCsvPath("backups", TENANT)).toBe(
      `/stats/export.csv?dataset=backups&${RANGE}&granularity=day`,
    );
    expect(statsPdfPath({ ...TENANT, granularity: "month" }, "en")).toBe(
      `/stats/report.pdf?${RANGE}&granularity=month&lang=en`,
    );
  });

  it("asks for the PDF in the UI language, English otherwise", () => {
    expect(statsPdfPath(TENANT, "de")).toMatch(/&lang=de$/);
    expect(statsPdfPath(TENANT, "de-AT")).toMatch(/&lang=de$/);
    expect(statsPdfPath(TENANT, "en-GB")).toMatch(/&lang=en$/);
    expect(statsPdfPath(TENANT, "fr")).toMatch(/&lang=en$/);
  });
});

describe("download requests", () => {
  const period = resolvePeriod({ period: "7d" }, new Date(2026, 8, 23, 12));

  it("asks for CSV with a descriptive fallback name", () => {
    expect(csvDownload("kpis", TENANT, period).path).toBe(
      `/stats/export.csv?dataset=kpis&${RANGE}&granularity=day`,
    );
    expect(csvDownload("largestObjects", TENANT, period)).toEqual({
      path: statsCsvPath("largestObjects", TENANT),
      accept: "text/csv",
      fallbackName: "restow-stats-largestObjects-2026-09-17_2026-09-23.csv",
    });
    expect(csvDownload("tenants", PROVIDER, period).fallbackName).toBe(
      "restow-stats-provider-tenants-2026-09-17_2026-09-23.csv",
    );
  });

  it("asks for the PDF report in the given language", () => {
    expect(pdfDownload(PROVIDER, period, "de")).toEqual({
      path: statsPdfPath(PROVIDER, "de"),
      accept: "application/pdf",
      fallbackName: "restow-stats-provider-report-2026-09-17_2026-09-23.pdf",
    });
  });
});

describe("normalizeStats", () => {
  const payload = {
    period: { from: TENANT.from, to: TENANT.to, granularity: "day", days: 7 },
    previous: { from: "2026-09-10", to: "2026-09-16" },
    scope: "tenant",
    kpis: {
      backupSuccessRate: { value: 0.98, previous: 0.95 },
      protectedObjects: { value: 42, previous: 40 },
      logicalBytes: { value: 4000, previous: 3000 },
      physicalBytes: { value: 1000, previous: 900 },
      dedupRatio: { value: 4, previous: 3.3 },
      restores: { value: 3, previous: null },
      verifiedShare: { value: null, previous: null },
      throttlingWaitSeconds: { unavailable: "no_microsoft_365_source" },
      failedItems: { value: 7, previous: 2 },
    },
    series: {
      backups: [
        { t: "2026-09-17", succeeded: 10, failed: 1, cancelled: 0 },
        { succeeded: 3 },
        "garbage",
      ],
      volume: [{ t: "2026-09-17", logicalBytes: 4000, physicalBytes: "1000" }],
      storage: { unavailable: "no_backups_yet" },
      jobDurations: [{ kind: "backup", p50Seconds: 60, p95Seconds: 300, count: 12 }, { p50: 1 }],
      throttling: [],
      restores: [{ t: "2026-09-17", completed: 1, failed: 0 }],
      readiness: [{ t: "2026-09-17", green: 30, yellow: 5, red: 1, unverified: 6 }],
    },
    tables: {
      failuresByCause: [{ cause: "ErrorItemNotFound", count: 4, lastAt: "2026-09-20T10:00:00Z" }],
      largestObjects: [
        { id: "o1", name: "ceo@example.com", kind: "mailbox", logicalBytes: 9000 },
        {
          id: "o2",
          name: "files@example.com",
          kind: "onedrive",
          logicalBytes: "4096",
          lastBackupAt: "2026-09-22T02:00:00Z",
          state: "no_backup",
          tenant: { id: "t9", name: "Example GmbH" },
        },
        { name: "no id" },
      ],
    },
  };

  it("decodes datasets, dropping rows without their key fields", () => {
    const stats = normalizeStats(payload, "tenant");
    expect(stats.period).toEqual({ from: TENANT.from, to: TENANT.to, granularity: "day" });
    expect(stats.previous).toEqual({ from: "2026-09-10", to: "2026-09-16", granularity: null });
    expect(stats.series.backups).toEqual({
      status: "ok",
      rows: [{ t: "2026-09-17", succeeded: 10, failed: 1, cancelled: 0 }],
    });
    expect(stats.series.jobDurations).toEqual({
      status: "ok",
      rows: [{ kind: "backup", p50Seconds: 60, p95Seconds: 300, count: 12 }],
    });
    expect(stats.series.throttling).toEqual({ status: "ok", rows: [] });
    expect(stats.tables.largestObjects).toEqual({
      status: "ok",
      rows: [
        {
          id: "o1",
          name: "ceo@example.com",
          kind: "mailbox",
          logicalBytes: 9000,
          lastBackupAt: null,
          state: null,
          tenant: null,
        },
        {
          id: "o2",
          name: "files@example.com",
          kind: "onedrive",
          logicalBytes: 4096,
          lastBackupAt: "2026-09-22T02:00:00Z",
          state: "no_backup",
          tenant: { id: "t9", name: "Example GmbH" },
        },
      ],
    });
  });

  it("reads numbers sent as strings (Postgres bigints) and nothing else", () => {
    const stats = normalizeStats(payload, "tenant");
    expect(stats.series.volume).toEqual({
      status: "ok",
      rows: [{ t: "2026-09-17", logicalBytes: 4000, physicalBytes: 1000 }],
    });
    const odd = normalizeStats(
      { kpis: { failedItems: { value: "12", previous: "n/a" }, restores: { value: "" } } },
      "tenant",
    );
    expect(odd.kpis.failedItems).toEqual({ status: "ok", value: 12, previous: null });
    expect(odd.kpis.restores).toEqual({ status: "ok", value: null, previous: null });
  });

  it("keeps unavailable datasets and key figures with their reason", () => {
    const stats = normalizeStats(payload, "tenant");
    expect(stats.series.storage).toEqual({ status: "unavailable", reason: "no_backups_yet" });
    expect(stats.kpis.throttlingWaitSeconds).toEqual({
      status: "unavailable",
      reason: "no_microsoft_365_source",
    });
    expect(stats.kpis.verifiedShare).toEqual({ status: "ok", value: null, previous: null });
    expect(stats.kpis.restores).toEqual({ status: "ok", value: 3, previous: null });
  });

  it("marks what the server did not send as unavailable, not zero", () => {
    const stats = normalizeStats({}, "tenant");
    for (const name of KPI_NAMES) {
      expect(stats.kpis[name]).toEqual({ status: "unavailable", reason: MISSING_REASON });
    }
    expect(stats.series.backups).toEqual({ status: "unavailable", reason: MISSING_REASON });
    expect(stats.tables.failuresByCause).toEqual({
      status: "unavailable",
      reason: MISSING_REASON,
    });
    expect(stats.period).toBeNull();
    expect(normalizeStats(null, "tenant").series.readiness.status).toBe("unavailable");
  });

  it("has no tenant table in the tenant scope", () => {
    expect(normalizeStats(payload, "tenant").tables.tenants).toBeNull();
  });

  it("reports a missing tenant table in the provider scope", () => {
    const stats = normalizeStats({ ...payload, scope: "provider" }, "provider");
    expect(stats.scope).toBe("provider");
    expect(stats.tables.tenants).toEqual({ status: "unavailable", reason: MISSING_REASON });
  });

  it("decodes the tenant rows of the provider scope", () => {
    const stats = normalizeStats(
      {
        ...payload,
        scope: "provider",
        tables: {
          ...payload.tables,
          tenants: [
            {
              id: "t1",
              name: "Example GmbH",
              objects: 12,
              successRate: 0.5,
              logicalBytes: 10,
              physicalBytes: 5,
              readiness: "yellow",
              failures: 3,
            },
            { id: "t2", successRate: null },
          ],
        },
      },
      "tenant",
    );
    expect(stats.tables.tenants).toEqual({
      status: "ok",
      rows: [
        {
          id: "t1",
          name: "Example GmbH",
          objects: 12,
          successRate: 0.5,
          logicalBytes: 10,
          physicalBytes: 5,
          readiness: "yellow",
          failures: 3,
        },
        {
          id: "t2",
          name: "t2",
          objects: 0,
          successRate: null,
          logicalBytes: 0,
          physicalBytes: 0,
          readiness: null,
          failures: 0,
        },
      ],
    });
  });
});
