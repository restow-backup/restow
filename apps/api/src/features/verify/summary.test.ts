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
  it("is red as soon as something cannot be restored or has no backup", () => {
    expect(overallReadiness([rated("green"), rated("no_backup")])).toBe("red");
    expect(overallReadiness([rated("yellow"), rated("red")])).toBe("red");
    expect(overallReadiness([rated("unverified"), rated("no_backup")])).toBe("red");
  });

  it("is yellow (Not proven) while something needs attention or is unverified", () => {
    expect(overallReadiness([rated("green"), rated("yellow")])).toBe("yellow");
    // UI rework decision 1: a backup no check has read back yet is not proven, not red.
    expect(overallReadiness([rated("green"), rated("unverified")])).toBe("yellow");
    // Decision 2: an overdue check is a callout; it does not change overall.
    expect(overallReadiness([rated("green"), rated("green", true)])).toBe("green");
  });

  it("reads the brief's case 0/0/1/1/18 as Not proven", () => {
    const objects = [
      rated("green"),
      rated("yellow"),
      ...Array.from({ length: 18 }, () => rated("unverified")),
    ];
    expect(overallReadiness(objects)).toBe("yellow");
    expect(summarize(objects, 0)).toMatchObject({
      total: 20,
      green: 1,
      yellow: 1,
      red: 0,
      unverified: 18,
      noBackup: 0,
      overall: "yellow",
    });
  });

  it("leaves objects confirmed as empty out of the rating, and counts them on their own", () => {
    expect(overallReadiness([rated("green"), rated("empty")])).toBe("green");
    expect(overallReadiness([rated("empty")])).toBe("green");
    expect(summarize([rated("green"), rated("empty"), rated("yellow")], 0)).toMatchObject({
      total: 3,
      green: 1,
      yellow: 1,
      empty: 1,
      overall: "yellow",
    });
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

describe("mail objects in no backup job", () => {
  const noJob = (state: RatedObject["state"] = "green"): RatedObject => ({
    ...rated(state),
    withoutJob: true,
    mail: true,
  });

  it("are counted apart from machines, guests and shares and listed as callouts, without changing overall", () => {
    expect(overallReadiness([rated("green"), noJob()])).toBe("green");
    // A backup that does not restore still makes the tenant red.
    expect(overallReadiness([rated("green"), noJob("red")])).toBe("red");
    const machine: RatedObject = { ...rated("green"), withoutJob: true };
    const guest: RatedObject = { ...rated("green"), withoutJob: true, guest: true };
    const share: RatedObject = { ...rated("green"), withoutJob: true, share: true };
    const summary = summarize([rated("green"), noJob(), noJob(), machine, guest, share], 0);
    expect(summary).toMatchObject({
      total: 6,
      withoutJob: 3,
      objectsWithoutJob: 2,
      guestsWithoutJob: 1,
      sharesWithoutJob: 1,
      overall: "green",
    });
  });

  it("count nothing for an object in a job", () => {
    const summary = summarize([{ ...rated("green"), mail: true }], 0);
    expect(summary).toMatchObject({ withoutJob: 0, objectsWithoutJob: 0, overall: "green" });
  });
});

describe("objects no longer backed up that wait for a confirmation", () => {
  it("are counted and listed as callouts; only their own rating changes overall", () => {
    const waiting: RatedObject = { ...rated("green"), toConfirm: true };
    // Decision 2: waiting for a confirmation does not turn the tenant yellow.
    expect(overallReadiness([rated("green"), waiting])).toBe("green");
    expect(overallReadiness([rated("green"), rated("red"), waiting])).toBe("red");
    const summary = summarize([rated("green"), waiting], 0, 2);
    expect(summary).toMatchObject({ toConfirm: 3, overall: "green", green: 2 });
  });

  it("no longer change overall, even without a backup to rate", () => {
    expect(overallReadiness([rated("green")])).toBe("green");
    expect(overallReadiness([])).toBeNull();
    expect(summarize([], 0, 1)).toMatchObject({ toConfirm: 1, overall: null });
    expect(summarize([rated("green")], 0).toConfirm).toBe(0);
  });
});
