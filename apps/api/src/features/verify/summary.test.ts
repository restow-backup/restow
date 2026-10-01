import { describe, expect, it } from "vitest";
import {
  type RatedObject,
  isFirstBackupOverdue,
  isOverdue,
  objectStateOf,
  overallReadiness,
  summarize,
  verifyBlockedReason,
} from "./summary.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function rated(state: RatedObject["state"], overdue = false, daysAgo = 1): RatedObject {
  return { state, overdue, checkedAt: new Date(NOW.getTime() - daysAgo * DAY) };
}

describe("objectStateOf", () => {
  it("uses the latest rating, otherwise says why there is none", () => {
    expect(objectStateOf("yellow", true)).toBe("yellow");
    expect(objectStateOf("red", false)).toBe("red");
    expect(objectStateOf(null, true)).toBe("unverified");
    expect(objectStateOf(null, false)).toBe("no_backup");
  });
});

describe("isOverdue", () => {
  it("flags ratings older than eight days", () => {
    expect(isOverdue(new Date(NOW.getTime() - 7 * DAY), NOW)).toBe(false);
    expect(isOverdue(new Date(NOW.getTime() - 9 * DAY), NOW)).toBe(true);
    expect(isOverdue(null, NOW)).toBe(false);
  });
});

describe("isFirstBackupOverdue", () => {
  it("gives a freshly protected object 24 hours before it counts as a problem", () => {
    expect(isFirstBackupOverdue(new Date(NOW.getTime() - 23 * 60 * 60 * 1000), NOW)).toBe(false);
    expect(isFirstBackupOverdue(new Date(NOW.getTime() - 25 * 60 * 60 * 1000), NOW)).toBe(true);
    expect(isFirstBackupOverdue(NOW, NOW)).toBe(false);
  });
});

describe("overallReadiness", () => {
  it("is red as soon as anything is unproven, a backup without verified restore included", () => {
    expect(overallReadiness([rated("green"), rated("unverified")])).toBe("red");
    expect(overallReadiness([rated("green"), rated("no_backup")])).toBe("red");
    expect(overallReadiness([rated("yellow"), rated("red")])).toBe("red");
  });

  it("is yellow when something needs attention or a check is overdue", () => {
    expect(overallReadiness([rated("green"), rated("yellow")])).toBe("yellow");
    expect(overallReadiness([rated("green"), rated("green", true)])).toBe("yellow");
  });

  it("is green only when everything is green and current, and null for nothing", () => {
    expect(overallReadiness([rated("green"), rated("green")])).toBe("green");
    expect(overallReadiness([])).toBeNull();
  });
});

describe("summarize", () => {
  it("counts states and finds the newest rating", () => {
    const summary = summarize(
      [
        rated("green", false, 3),
        rated("red", false, 1),
        rated("unverified"),
        rated("green", true, 10),
      ],
      2,
    );
    expect(summary).toMatchObject({
      total: 4,
      green: 2,
      red: 1,
      unverified: 1,
      noBackup: 0,
      overdue: 1,
      overall: "red",
      running: 2,
    });
    expect(summary.lastCheckedAt).toBe(new Date(NOW.getTime() - DAY).toISOString());
  });
});

describe("verifyBlockedReason", () => {
  it("allows every object with a backup except excluded ones", () => {
    expect(verifyBlockedReason({ status: "active", hasSnapshot: true })).toBeNull();
    expect(verifyBlockedReason({ status: "orphaned", hasSnapshot: true })).toBeNull();
    expect(verifyBlockedReason({ status: "active", hasSnapshot: false })).toBe("no_backup");
    expect(verifyBlockedReason({ status: "excluded", hasSnapshot: true })).toBe("excluded");
  });
});
