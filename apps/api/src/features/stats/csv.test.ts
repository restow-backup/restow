import { describe, expect, it } from "vitest";
import { CSV_BOM, csvField, datasetTable, neutralise, toCsv } from "./csv.js";
import type { StatsDto } from "./dto.js";

const kpi = (value: number | null, previous: number | null) => ({ value, previous });

function stats(overrides: Partial<StatsDto> = {}): StatsDto {
  return {
    period: { from: "2026-09-01", to: "2026-09-02", granularity: "day", days: 2 },
    previous: { from: "2026-08-30", to: "2026-08-31" },
    scope: "tenant",
    kpis: {
      backupSuccessRate: kpi(0.75, 1),
      protectedObjects: kpi(3, 2),
      logicalBytes: kpi(3000, 1000),
      physicalBytes: kpi(1200, 600),
      dedupRatio: kpi(2.5, null),
      restores: kpi(1, 0),
      verifiedShare: kpi(0.6667, 0.5),
      throttlingWaitSeconds: kpi(null, null),
      failedItems: kpi(4, 0),
    },
    series: {
      backups: [
        { t: "2026-09-01", succeeded: 2, failed: 1, cancelled: 0 },
        { t: "2026-09-02", succeeded: 1, failed: 0, cancelled: 1 },
      ],
      volume: [{ t: "2026-09-01", logicalBytes: 10, physicalBytes: 4 }],
      storage: [{ t: "2026-09-01", bytes: 1200 }],
      jobDurations: [{ kind: "backup", p50Seconds: 30, p95Seconds: 90.5, count: 4 }],
      throttling: { unavailable: "no_microsoft_365_source" },
      restores: [{ t: "2026-09-01", completed: 1, failed: 0 }],
      readiness: [{ t: "2026-09-01", green: 1, yellow: 1, red: 0, unverified: 1 }],
    },
    tables: {
      failuresByCause: [
        { cause: '=HYPERLINK("http://x","click")', count: 2, lastAt: "2026-09-02T08:00:00.000Z" },
        { cause: "Graph 404 ErrorItemNotFound", count: 1, lastAt: "2026-09-01T08:00:00.000Z" },
      ],
      largestObjects: [
        {
          id: "o1",
          name: "Müller, Anna",
          kind: "mailbox",
          logicalBytes: 2000,
          lastBackupAt: "2026-09-02T03:00:00.000Z",
          state: "green",
        },
      ],
    },
    generatedAt: "2026-09-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("csvField", () => {
  it("quotes fields with commas, quotes and line breaks, doubling quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\r\nlines")).toBe('"two\r\nlines"');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
  });

  it("writes numbers as numbers and empty cells for missing values", () => {
    expect(csvField(42)).toBe("42");
    expect(csvField(-3)).toBe("-3");
    expect(csvField(0.25)).toBe("0.25");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("neutralises text that a spreadsheet would run as a formula", () => {
    for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(neutralise(`${trigger}SUM(A1:A9)`)).toBe(`'${trigger}SUM(A1:A9)`);
    }
    expect(neutralise("safe=text")).toBe("safe=text");
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("-cmd|' /C calc'!A0")).toBe("'-cmd|' /C calc'!A0");
    // Neutralised first, then quoted: the apostrophe sits inside the quotes.
    expect(csvField('=HYPERLINK("http://x","click")')).toBe(
      '"\'=HYPERLINK(""http://x"",""click"")"',
    );
  });
});

describe("toCsv", () => {
  it("starts with a byte order mark, then the header row, CRLF after every record", () => {
    const csv = toCsv(
      ["t", "name"],
      [
        ["2026-09-01", "Zürich"],
        ["2026-09-02", null],
      ],
    );
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1)).toBe("t,name\r\n2026-09-01,Zürich\r\n2026-09-02,\r\n");
    expect(Buffer.from(csv, "utf8").subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

describe("datasetTable", () => {
  it("exports a series with the contract's field names as the header row", () => {
    const table = datasetTable(stats(), "backups");
    expect(table).toEqual({
      header: ["t", "succeeded", "failed", "cancelled"],
      rows: [
        ["2026-09-01", 2, 1, 0],
        ["2026-09-02", 1, 0, 1],
      ],
    });
  });

  it("exports the key figures with empty cells where a value is missing", () => {
    const table = datasetTable(stats(), "kpis");
    if (!table || "unavailable" in table) {
      throw new Error("expected a table");
    }
    const csv = toCsv(table.header, table.rows);
    expect(csv).toContain("metric,value,previous\r\n");
    expect(csv).toContain("dedupRatio,2.5,\r\n");
    expect(csv).toContain("throttlingWaitSeconds,,\r\n");
  });

  it("guards the failure causes against formula injection", () => {
    const table = datasetTable(stats(), "failuresByCause");
    if (!table || "unavailable" in table) {
      throw new Error("expected a table");
    }
    const csv = toCsv(table.header, table.rows);
    expect(csv.split("\r\n")[1]).toBe(
      '"\'=HYPERLINK(""http://x"",""click"")",2,2026-09-02T08:00:00.000Z',
    );
    expect(csv).toContain("\r\nGraph 404 ErrorItemNotFound,1,2026-09-01T08:00:00.000Z\r\n");
  });

  it("quotes names with commas in the largest objects", () => {
    const table = datasetTable(stats(), "largestObjects");
    if (!table || "unavailable" in table) {
      throw new Error("expected a table");
    }
    expect(toCsv(table.header, table.rows)).toContain(
      'o1,"Müller, Anna",mailbox,2000,2026-09-02T03:00:00.000Z,green',
    );
  });

  it("reports an unavailable dataset instead of an empty file", () => {
    expect(datasetTable(stats(), "throttling")).toEqual({ unavailable: "no_microsoft_365_source" });
  });

  it("has no tenant table outside the provider scope", () => {
    expect(datasetTable(stats(), "tenants")).toBeNull();
    const provider = stats({
      scope: "provider",
      tables: {
        ...stats().tables,
        tenants: [
          {
            id: "t1",
            name: "+Contoso",
            objects: 3,
            successRate: null,
            logicalBytes: 1,
            physicalBytes: 1,
            readiness: null,
            failures: 0,
          },
        ],
      },
    });
    const table = datasetTable(provider, "tenants");
    if (!table || "unavailable" in table) {
      throw new Error("expected a table");
    }
    expect(toCsv(table.header, table.rows).split("\r\n").slice(0, 2)).toEqual([
      `${CSV_BOM}id,name,objects,successRate,logicalBytes,physicalBytes,readiness,failures`,
      "t1,'+Contoso,3,,1,1,,0",
    ]);
  });
});
