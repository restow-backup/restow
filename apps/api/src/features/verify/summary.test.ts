import { describe, expect, it } from "vitest";
import {
  isFirstBackupOverdue,
  isOverdue,
  objectStateOf,
  overallReadiness,
  type RatedObject,
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

describe("objects no longer backed up that wait for a confirmation", () => {
  it("keep the tenant from green, never make it red, and are counted", () => {
    const waiting: RatedObject = { ...rated("green"), toConfirm: true };
    expect(overallReadiness([rated("green"), waiting])).toBe("yellow");
    expect(overallReadiness([rated("green"), rated("red"), waiting])).toBe("red");
    const summary = summarize([rated("green"), waiting], 0, 2);
    expect(summary).toMatchObject({ toConfirm: 3, overall: "yellow", green: 2 });
  });

  it("make a tenant yellow even when none of them has a backup to rate", () => {
    expect(overallReadiness([rated("green")], 1)).toBe("yellow");
    expect(overallReadiness([], 1)).toBe("yellow");
    expect(overallReadiness([], 0)).toBeNull();
    expect(summarize([rated("green")], 0).toConfirm).toBe(0);
  });
});
