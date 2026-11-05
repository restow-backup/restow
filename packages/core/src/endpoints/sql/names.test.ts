import { describe, expect, it } from "vitest";
import { defaultRestoreName, isSqlVerifyName, safeFilePart, sqlNewNameIssue } from "./names.js";

describe("SQL names", () => {
  it("checks a new name like the agent", () => {
    expect(sqlNewNameIssue("Sales_restored_20261105")).toBeNull();
    expect(sqlNewNameIssue("")).toBe("empty");
    expect(sqlNewNameIssue("x".repeat(129))).toBe("too_long");
    expect(sqlNewNameIssue("ä".repeat(128))).toBeNull();
    expect(sqlNewNameIssue("a\u0001b")).toBe("control_characters");
    expect(sqlNewNameIssue("MSDB")).toBe("system");
    expect(sqlNewNameIssue("Sales__restow_verify_x")).toBe("reserved");
  });

  it("knows the shape of the check databases", () => {
    expect(isSqlVerifyName("Sales__restow_verify_20261108T030000Z")).toBe(true);
    expect(isSqlVerifyName("Sales__restow_verify_")).toBe(false);
    expect(isSqlVerifyName(`${"x".repeat(81)}__restow_verify_20261108T030000Z`)).toBe(false);
  });

  it("proposes a name and a file name part", () => {
    expect(defaultRestoreName("Sales", new Date("2026-11-05T10:00:00Z"))).toBe(
      "Sales_restored_20261105",
    );
    expect(Array.from(defaultRestoreName("ü".repeat(128), new Date())).length).toBe(128);
    expect(safeFilePart("Sales DB/../x")).toBe("Sales_DB_x");
    expect(safeFilePart("ßß")).toBe("database");
  });
});
