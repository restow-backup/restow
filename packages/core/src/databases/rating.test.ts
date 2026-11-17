import { describe, expect, it } from "vitest";
import { dbListRank, rateDatabase } from "./rating.js";

const now = new Date("2026-11-17T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3600_000);

describe("rating of a database (docs/DATABASES.md 2.4)", () => {
  const base = {
    excluded: false,
    lastBackupAt: hoursAgo(1),
    lastGreenCheckAt: hoursAgo(20),
    lastCheckRed: false,
    intervalMinutes: 60,
    now,
  };

  it("is green only with a recent backup and a green check", () => {
    expect(rateDatabase(base)).toBe("green");
    expect(rateDatabase({ ...base, lastGreenCheckAt: null })).toBe("unverified");
    expect(rateDatabase({ ...base, lastGreenCheckAt: hoursAgo(8 * 24 + 1) })).toBe("overdue");
  });

  it("is not protected without a backup or when left out, red after a red check", () => {
    expect(rateDatabase({ ...base, lastBackupAt: null })).toBe("not_protected");
    expect(rateDatabase({ ...base, excluded: true })).toBe("not_protected");
    expect(rateDatabase({ ...base, lastCheckRed: true })).toBe("red");
  });

  it("is overdue after three schedules, at least 24 hours", () => {
    expect(rateDatabase({ ...base, lastBackupAt: hoursAgo(23) })).toBe("green");
    expect(rateDatabase({ ...base, lastBackupAt: hoursAgo(25) })).toBe("overdue");
    expect(rateDatabase({ ...base, intervalMinutes: 24 * 60, lastBackupAt: hoursAgo(71) })).toBe(
      "green",
    );
    expect(rateDatabase({ ...base, intervalMinutes: 24 * 60, lastBackupAt: hoursAgo(73) })).toBe(
      "overdue",
    );
  });

  it("sorts red, then not reachable, overdue, unverified", () => {
    const ranks = [
      dbListRank("unverified", true),
      dbListRank("overdue", true),
      dbListRank("green", false),
      dbListRank("red", false),
    ];
    expect([...ranks].sort((a, b) => a - b)).toEqual([ranks[3], ranks[2], ranks[1], ranks[0]]);
  });
});
