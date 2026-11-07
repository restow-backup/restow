import { describe, expect, it } from "vitest";
import { judgeSqlVerifyDatabase } from "./judge.js";
import type { SqlVerifyDatabaseReport } from "./schemas.js";

const green: SqlVerifyDatabaseReport = {
  name: "Sales",
  method: "restore+checkdb",
  fetched: true,
  sha256Match: true,
  restore: { ok: true, errors: [] },
  checkdb: { ran: true, physicalOnly: false, errors: [] },
};

describe("judgeSqlVerifyDatabase", () => {
  it.each<[string, Partial<SqlVerifyDatabaseReport>, string]>([
    ["all steps clean", {}, "green"],
    [
      "PHYSICAL_ONLY still green",
      { checkdb: { ran: true, physicalOnly: true, errors: [] } },
      "green",
    ],
    ["another SHA-256", { sha256Match: false, restore: null, checkdb: null }, "red"],
    [
      "CHECKDB errors",
      { checkdb: { ran: true, physicalOnly: false, errors: [{ number: 8928, message: "page" }] } },
      "red",
    ],
    [
      "RESTORE names the backup",
      { restore: { ok: false, errors: [{ number: 3241, message: "media" }] }, checkdb: null },
      "red",
    ],
    [
      "RESTORE fails for another reason",
      {
        restore: { ok: false, errors: [{ number: 5133, message: "path" }] },
        checkdb: null,
        code: "sql_restore_failed",
      },
      "incomplete",
    ],
    ["VERIFYONLY never counts", { method: "verifyonly" }, "incomplete"],
    [
      "nothing fetched",
      { fetched: false, sha256Match: null, restore: null, checkdb: null },
      "incomplete",
    ],
    [
      "CHECKDB did not run",
      { checkdb: { ran: false, physicalOnly: false, errors: [] } },
      "incomplete",
    ],
    ["no SHA comparison", { sha256Match: null }, "incomplete"],
  ])("%s", (_label, change, outcome) => {
    expect(judgeSqlVerifyDatabase({ ...green, ...change }).outcome).toBe(outcome);
  });

  it("keeps the agent's code of an incomplete check", () => {
    expect(
      judgeSqlVerifyDatabase({
        ...green,
        restore: null,
        checkdb: null,
        code: "sql_verify_timeout",
      }),
    ).toEqual({ outcome: "incomplete", code: "sql_verify_timeout", evidence: [] });
    expect(judgeSqlVerifyDatabase({ ...green, restore: null, checkdb: null }).code).toBe(
      "sql_verify_incomplete",
    );
  });
});
