import { describe, expect, it } from "vitest";
import { rateSqlDatabase, SQL_GREEN_VALID_MS } from "./rating.js";

const now = new Date("2026-11-20T12:00:00Z");

describe("rateSqlDatabase", () => {
  it("rates by the newest backup and the newest result", () => {
    expect(rateSqlDatabase({ lastBackupAt: null, lastResult: null, now })).toBe("not_protected");
    expect(rateSqlDatabase({ lastBackupAt: now, lastResult: null, now })).toBe("unverified");
    expect(
      rateSqlDatabase({ lastBackupAt: now, lastResult: { outcome: "green", checkedAt: now }, now }),
    ).toBe("green");
    expect(
      rateSqlDatabase({ lastBackupAt: now, lastResult: { outcome: "red", checkedAt: now }, now }),
    ).toBe("red");
    const old = new Date(now.getTime() - SQL_GREEN_VALID_MS - 1);
    expect(
      rateSqlDatabase({ lastBackupAt: now, lastResult: { outcome: "green", checkedAt: old }, now }),
    ).toBe("overdue");
    // Red stays red however old it is: only a green check ends it.
    expect(
      rateSqlDatabase({ lastBackupAt: now, lastResult: { outcome: "red", checkedAt: old }, now }),
    ).toBe("red");
  });
});
