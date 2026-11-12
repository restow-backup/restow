import { describe, expect, it } from "vitest";
import { appFilesNotices, appSubjectsOf } from "./notices.js";
import {
  defaultSqlSettings,
  type SqlSettings,
  sqlCoversEverything,
  sqlDatabaseSelected,
  sqlVerifyOf,
  sqlVerifySlotTooClose,
} from "./settings.js";

const on: SqlSettings = { ...defaultSqlSettings(), enabled: true };

describe("SQL settings", () => {
  it("select databases by instance, list and exclusion, never tempdb", () => {
    expect(sqlDatabaseSelected(on, "SQLEXPRESS", "Sales")).toBe(true);
    expect(sqlDatabaseSelected(on, "SQLEXPRESS", "TempDB")).toBe(false);
    expect(sqlDatabaseSelected(defaultSqlSettings(), "SQLEXPRESS", "Sales")).toBe(false);
    const some: SqlSettings = {
      ...on,
      instances: ["sqlexpress"],
      databases: [{ name: "sales" }, { instance: "OTHER", name: "Archive" }],
      exclude: [{ instance: "SQLEXPRESS", name: "Scratch" }],
    };
    expect(sqlDatabaseSelected(some, "SQLEXPRESS", "Sales")).toBe(true);
    expect(sqlDatabaseSelected(some, "SQLEXPRESS", "Archive")).toBe(false);
    expect(sqlDatabaseSelected(some, "OTHER", "Sales")).toBe(false);
    expect(sqlDatabaseSelected({ ...on, exclude: [{ name: "Scratch" }] }, "X", "scratch")).toBe(
      false,
    );
  });

  it("know when they cover every database", () => {
    expect(sqlCoversEverything(on)).toBe(true);
    expect(sqlCoversEverything({ ...on, exclude: [{ name: "x" }] })).toBe(false);
    expect(sqlCoversEverything({ ...on, instances: ["A"] })).toBe(false);
    expect(sqlCoversEverything(null)).toBe(false);
  });

  it("default the check to Sunday 03:00 and keep the slot an hour off the daily backup", () => {
    expect(sqlVerifyOf(undefined)).toEqual({
      enabled: true,
      weekday: 7,
      time: "03:00",
      maxGiB: 200,
      physicalOnly: false,
    });
    expect(sqlVerifySlotTooClose("03:00", "02:30")).toBe(true);
    expect(sqlVerifySlotTooClose("03:00", "02:00")).toBe(false);
    expect(sqlVerifySlotTooClose("00:20", "23:40")).toBe(true);
    expect(sqlVerifySlotTooClose("03:00", null)).toBe(false);
  });
});

describe("the fixed app warnings (W1)", () => {
  const roles = {
    domainController: true,
    dfsr: true,
    exchange: false,
    hyperV: true,
    sqlServer: true,
  };

  it("name every role the machine has", () => {
    expect(appSubjectsOf({ roles, productType: "domain_controller" }, null)).toEqual([
      "sql_server",
      "active_directory",
      "hyper_v",
    ]);
    expect(appSubjectsOf(null, null)).toEqual([]);
  });

  it("drop SQL Server once the native backup covers every database", () => {
    expect(appFilesNotices({ roles, productType: "server" }, on)).toEqual([
      { code: "app_files_not_app_backup", subjects: ["active_directory", "hyper_v"] },
    ]);
    const sqlOnly = { ...roles, domainController: false, hyperV: false };
    expect(appFilesNotices({ roles: sqlOnly, productType: "server" }, on)).toEqual([]);
    expect(
      appFilesNotices(
        { roles: sqlOnly, productType: "server" },
        { ...on, databases: [{ name: "Sales" }] },
      ),
    ).toEqual([{ code: "app_files_not_app_backup", subjects: ["sql_server"] }]);
  });
});
