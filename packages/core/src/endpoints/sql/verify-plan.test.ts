import { describe, expect, it } from "vitest";
import { DEFAULT_SQL_VERIFY } from "./settings.js";
import { latestSqlVerifySlot, sqlVerifyDue, sqlVerifyTaskParams } from "./verify-plan.js";

const ZONE = "Europe/Berlin";

describe("the SQL check plan", () => {
  it("finds the newest slot: Sunday 03:00 in the job's zone", () => {
    // Thursday, 5 November 2026: the last Sunday was 1 November (CET, UTC+1).
    expect(latestSqlVerifySlot(DEFAULT_SQL_VERIFY, ZONE, new Date("2026-11-05T12:00:00Z"))).toEqual(
      new Date("2026-11-01T02:00:00Z"),
    );
    // Sunday 8 November, 02:59 local: still the week before.
    expect(latestSqlVerifySlot(DEFAULT_SQL_VERIFY, ZONE, new Date("2026-11-08T01:59:00Z"))).toEqual(
      new Date("2026-11-01T02:00:00Z"),
    );
    expect(latestSqlVerifySlot(DEFAULT_SQL_VERIFY, ZONE, new Date("2026-11-08T02:00:00Z"))).toEqual(
      new Date("2026-11-08T02:00:00Z"),
    );
    expect(latestSqlVerifySlot({ weekday: 9, time: "03:00" }, ZONE, new Date())).toBeNull();
  });

  it("plans once per slot", () => {
    const now = new Date("2026-11-08T02:10:00Z");
    expect(sqlVerifyDue(DEFAULT_SQL_VERIFY, ZONE, null, now)).toBe(true);
    expect(sqlVerifyDue(DEFAULT_SQL_VERIFY, ZONE, new Date("2026-11-01T02:05:00Z"), now)).toBe(
      true,
    );
    expect(sqlVerifyDue(DEFAULT_SQL_VERIFY, ZONE, new Date("2026-11-08T02:05:00Z"), now)).toBe(
      false,
    );
    expect(sqlVerifyDue({ ...DEFAULT_SQL_VERIFY, enabled: false }, ZONE, null, now)).toBe(false);
  });

  it("builds the task of the contract", () => {
    const backup = {
      id: "a9e8d7c6-b5a4-4392-8170-6f5e4d3c2b1a",
      snapshotId: "1".repeat(64),
      pathInSnapshot: "/C/ProgramData/Restow/data/staging/sql/SQLEXPRESS/Sales~8de4e0ea/full.bak",
      sha256: "2".repeat(64),
      bytes: 100,
      fileList: [],
    };
    expect(sqlVerifyTaskParams("SQLEXPRESS", DEFAULT_SQL_VERIFY, [])).toBeNull();
    expect(
      sqlVerifyTaskParams("SQLEXPRESS", DEFAULT_SQL_VERIFY, [
        { databaseId: "d2", name: "Sales", usedBytes: 0, backup },
        { databaseId: "d1", name: "Archive", usedBytes: 50, backup },
      ]),
    ).toEqual({
      instance: "SQLEXPRESS",
      maxGiB: 200,
      physicalOnly: false,
      databases: [
        expect.objectContaining({ databaseId: "d1", name: "Archive", usedBytes: 50 }),
        expect.objectContaining({
          databaseId: "d2",
          name: "Sales",
          usedBytes: 100,
          backupId: backup.id,
        }),
      ],
    });
  });
});
