import { describe, expect, it } from "vitest";

import {
  checkSettings,
  refsOfLines,
  settingsDraftOf,
  settingsOfDraft,
  sqlDraftOf,
  sqlOfDraft,
  sqlSlotTooClose,
} from "./form.js";

describe("the SQL Server settings of a machine job", () => {
  it("are saved only once the job has them or they are switched on", () => {
    expect("sql" in settingsOfDraft(settingsDraftOf({ paths: ["C:\\Data"] }))).toBe(false);
    const draft = settingsDraftOf({ paths: ["C:\\Data"] });
    const on = settingsOfDraft({ ...draft, sql: { ...draft.sql, enabled: true } });
    expect(on.sql).toEqual({
      enabled: true,
      mode: "alongside",
      instances: "all",
      databases: "all",
      exclude: [],
      verify: { enabled: true, weekday: 7, time: "03:00", maxGiB: 200, physicalOnly: false },
    });
    // Switched off again, they stay as `enabled: false`.
    if (!on.sql) throw new Error("no SQL settings");
    const off = settingsOfDraft(settingsDraftOf({ ...on, sql: { ...on.sql, enabled: false } }));
    expect(off.sql?.enabled).toBe(false);
  });

  it("round-trip with lists, an exclusion and a staging folder", () => {
    const stored = {
      enabled: true,
      mode: "alongside" as const,
      instances: ["SQLEXPRESS"],
      databases: [{ name: "Sales" }, { instance: "SQLEXPRESS", name: "Archive" }],
      exclude: [{ instance: "SQLEXPRESS", name: "Scratch" }],
      stagingDir: "E:\\SqlStaging",
      verify: { enabled: true, weekday: 6, time: "01:30", maxGiB: 50, physicalOnly: true },
    };
    const draft = sqlDraftOf(stored);
    expect(draft.databases).toBe("Sales\nSQLEXPRESS\\Archive");
    expect(sqlOfDraft(draft)).toEqual(stored);
    expect(refsOfLines(" a \n\nB\\c\n\\d\n")).toEqual([
      { name: "a" },
      { instance: "B", name: "c" },
      { name: "\\d" },
    ]);
  });

  it("refuse what the API would refuse", () => {
    const draft = settingsDraftOf({ paths: ["C:\\Data"] });
    const sql = {
      ...draft.sql,
      enabled: true,
      databasesAll: false,
      databases: "",
      stagingDir: "\\\\server\\share",
      verifyTime: "25:00",
      verifyMaxGiB: "0",
    };
    expect(Object.keys(checkSettings({ ...draft, sql })).sort()).toEqual([
      "sqlDatabases",
      "sqlStagingDir",
      "sqlVerifyMaxGiB",
      "sqlVerifyTime",
    ]);
    expect(checkSettings({ ...draft, sql: { ...sql, enabled: false } })).toEqual({});
  });

  it("keep the check an hour off the daily backup, around midnight too", () => {
    expect(sqlSlotTooClose("03:00", "02:30")).toBe(true);
    expect(sqlSlotTooClose("03:00", "02:00")).toBe(false);
    expect(sqlSlotTooClose("23:50", "00:20")).toBe(true);
    expect(sqlSlotTooClose("03:00", null)).toBe(false);
  });
});
