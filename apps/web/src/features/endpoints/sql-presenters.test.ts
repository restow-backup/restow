import { describe, expect, it } from "vitest";

import {
  runErrorView,
  runStatusView,
  showsSqlTab,
  sqlCodeMessage,
  sqlNewNameProblem,
  sqlOutcomeView,
  sqlProposedName,
  sqlRatingView,
  windowsRoleKeys,
  windowsVersionLine,
} from "./presenters.js";

const windows = {
  productName: "Windows Server 2022 Standard",
  displayVersion: "21H2",
  build: 20348,
  ubr: 2340,
  productType: "server" as const,
  roles: { domainController: false, dfsr: true, exchange: false, hyperV: false, sqlServer: true },
};

describe("Windows and SQL Server presenters", () => {
  it("words the Windows version like the agent", () => {
    expect(windowsVersionLine(windows)).toBe(
      "Windows Server 2022 Standard 21H2 (build 20348.2340)",
    );
    expect(windowsVersionLine({ ...windows, displayVersion: "", ubr: 0 })).toBe(
      "Windows Server 2022 Standard (build 20348)",
    );
    expect(windowsRoleKeys({ ...windows, productType: "domain_controller" })).toEqual([
      "windowsFacts.roles.domainController",
      "windowsFacts.roles.sqlServer",
      "windowsFacts.roles.dfsr",
    ]);
  });

  it("offers the SQL tab only for a Windows machine that reports SQL Server", () => {
    const machine = (sqlServer: boolean) => ({
      facts: {
        virtualization: "vm" as const,
        technology: "",
        desktop: false,
        windows: {
          ...windows,
          editionId: "ServerStandard",
          installationType: "server",
          domainMember: false,
          domain: "",
          roles: { ...windows.roles, sqlServer },
          sqlInstances: [],
          bitlocker: { state: "ok" as const, volumes: [] },
        },
      },
      profileDetection: null,
    });
    expect(showsSqlTab({ os: "windows", machine: machine(true) })).toBe(true);
    expect(showsSqlTab({ os: "windows", machine: machine(false) })).toBe(false);
    expect(showsSqlTab({ os: "linux", machine: machine(true) })).toBe(false);
    expect(showsSqlTab({ os: "windows", machine: { facts: null, profileDetection: null } })).toBe(
      false,
    );
  });

  it("keeps green for a check that proved the backup, never for a mere backup", () => {
    expect(sqlRatingView("green").tone).toBe("success");
    expect(sqlRatingView("unverified").tone).toBe("neutral");
    expect(sqlRatingView("red").tone).toBe("destructive");
    expect(sqlRatingView("overdue").tone).toBe("warning");
    expect(sqlRatingView("not_protected").tone).toBe("muted");
    expect(sqlOutcomeView("backed_up").tone).toBe("neutral");
    expect(sqlOutcomeView("green").tone).toBe("success");
    // The agent's "succeeded" of a check is no rating: the server judges.
    expect(runStatusView("succeeded", "sql_verify").tone).toBe("neutral");
    expect(runStatusView("succeeded", "sql").tone).toBe("neutral");
    expect(runStatusView("succeeded", "sql_restore").tone).toBe("success");
  });

  it("words the SQL codes of a run and shows an unknown one raw", () => {
    expect(runErrorView({ code: "sql_login_missing" }).headline).toEqual({
      key: "sql.codes.sql_login_missing",
    });
    expect(sqlCodeMessage("sql_future_code")).toEqual({
      key: "sql.codes.unknown",
      values: { code: "sql_future_code" },
    });
    expect(sqlCodeMessage(null)).toBeNull();
  });

  it("checks a new name like the server and the agent", () => {
    expect(sqlProposedName("Sales", new Date("2026-11-05T10:00:00Z"))).toBe(
      "Sales_restored_20261105",
    );
    expect(sqlNewNameProblem("Sales_copy", "Sales")).toBeNull();
    expect(sqlNewNameProblem("", "Sales")).toBe("empty");
    expect(sqlNewNameProblem("sales", "Sales")).toBe("same");
    expect(sqlNewNameProblem("tempdb", "Sales")).toBe("system");
    expect(sqlNewNameProblem("x__restow_verify_1", "Sales")).toBe("reserved");
    expect(sqlNewNameProblem("x".repeat(129), "Sales")).toBe("tooLong");
  });
});
