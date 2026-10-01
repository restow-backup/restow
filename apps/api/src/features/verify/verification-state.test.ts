import { describe, expect, it } from "vitest";
import {
  type RatedReport,
  isStorageFinding,
  newestOf,
  objectVerificationOf,
  ratingReport,
  snapshotVerificationOf,
  unverifiedSnapshot,
} from "./verification-state.js";

const SNAPSHOT_N = "7d1c0b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const SNAPSHOT_N1 = "8e2d1c3b-4f5a-4b6c-9d7e-8f9a0b1c2d3e";

const at = (hour: number) => new Date(Date.UTC(2026, 8, 20, hour));

function check(
  id: string,
  readiness: RatedReport["readiness"],
  hour: number,
  snapshotId: string,
): RatedReport {
  return { id, readiness, checkedAt: at(hour), snapshotId, origin: "verify" };
}

function finding(id: string, hour: number): RatedReport {
  return { id, readiness: "red", checkedAt: at(hour), snapshotId: null, origin: "scrub" };
}

describe("objectVerificationOf", () => {
  it("rates an object by the check of its newest backup", () => {
    const green = check("r1", "green", 3, SNAPSHOT_N);
    expect(
      objectVerificationOf({
        latestSnapshotId: SNAPSHOT_N,
        latestCheck: green,
        latestFinding: null,
        newestCheck: green,
      }),
    ).toEqual({ state: "green", report: green, previous: null });
  });

  it("calls a newer backup unverified, whatever the older one scored", () => {
    const green = check("r1", "green", 3, SNAPSHOT_N);
    const verification = objectVerificationOf({
      latestSnapshotId: SNAPSHOT_N1,
      latestCheck: null,
      latestFinding: null,
      newestCheck: green,
    });
    expect(verification).toEqual({ state: "unverified", report: null, previous: green });
  });

  it("never lets a check of another snapshot rate the newest one", () => {
    const green = check("r1", "green", 3, SNAPSHOT_N);
    expect(
      objectVerificationOf({
        latestSnapshotId: SNAPSHOT_N1,
        latestCheck: green,
        latestFinding: null,
        newestCheck: green,
      }).state,
    ).toBe("unverified");
  });

  it("is unverified when no check ever ran, and no_backup without a backup", () => {
    expect(
      objectVerificationOf({
        latestSnapshotId: SNAPSHOT_N,
        latestCheck: null,
        latestFinding: null,
        newestCheck: null,
      }),
    ).toEqual({ state: "unverified", report: null, previous: null });
    expect(
      objectVerificationOf({
        latestSnapshotId: null,
        latestCheck: null,
        latestFinding: null,
        newestCheck: check("r1", "green", 3, SNAPSHOT_N),
      }),
    ).toEqual({ state: "no_backup", report: null, previous: null });
  });

  it("turns red when the storage check found damage after the newest backup's check", () => {
    const green = check("r1", "green", 3, SNAPSHOT_N);
    const damage = finding("f1", 5);
    expect(
      objectVerificationOf({
        latestSnapshotId: SNAPSHOT_N,
        latestCheck: green,
        latestFinding: damage,
        newestCheck: green,
      }),
    ).toEqual({ state: "red", report: damage, previous: null });
  });

  it("keeps a storage finding on a new, unchecked backup until a check examined it", () => {
    const damage = finding("f1", 5);
    expect(
      objectVerificationOf({
        latestSnapshotId: SNAPSHOT_N1,
        latestCheck: null,
        latestFinding: damage,
        newestCheck: check("r1", "green", 3, SNAPSHOT_N),
      }).state,
    ).toBe("red");

    // A check after the finding already accounted for the damage.
    const later = check("r2", "green", 7, SNAPSHOT_N);
    expect(
      objectVerificationOf({
        latestSnapshotId: SNAPSHOT_N1,
        latestCheck: null,
        latestFinding: damage,
        newestCheck: later,
      }),
    ).toEqual({ state: "unverified", report: null, previous: later });
  });

  it("lets a check after the finding rate the newest backup again", () => {
    const recheck = check("r2", "green", 7, SNAPSHOT_N);
    expect(
      objectVerificationOf({
        latestSnapshotId: SNAPSHOT_N,
        latestCheck: recheck,
        latestFinding: finding("f1", 5),
        newestCheck: recheck,
      }),
    ).toEqual({ state: "green", report: recheck, previous: null });
  });
});

describe("ratingReport / snapshotVerificationOf", () => {
  it("reports an unchecked snapshot as unverified", () => {
    expect(ratingReport(null, null, null)).toBeNull();
    expect(snapshotVerificationOf(null, null, at(9))).toEqual(unverifiedSnapshot());
    expect(unverifiedSnapshot()).toEqual({ state: "unverified", checkedAt: null, reportId: null });
  });

  it("carries the rating, the date and the report of a checked snapshot", () => {
    expect(snapshotVerificationOf(check("r1", "yellow", 3, SNAPSHOT_N), null, at(3))).toEqual({
      state: "yellow",
      checkedAt: at(3).toISOString(),
      reportId: "r1",
    });
  });

  it("rates a checked snapshot red once damage was found after its check", () => {
    const green = check("r1", "green", 3, SNAPSHOT_N);
    expect(snapshotVerificationOf(green, finding("f1", 5), at(3))).toMatchObject({
      state: "red",
      reportId: "f1",
    });
    expect(snapshotVerificationOf(green, finding("f0", 1), at(3))).toMatchObject({
      state: "green",
      reportId: "r1",
    });
  });

  it("returns fresh objects, so callers may not share one unverified value by accident", () => {
    expect(unverifiedSnapshot()).not.toBe(unverifiedSnapshot());
  });
});

describe("helpers", () => {
  it("recognizes storage findings by their origin", () => {
    expect(isStorageFinding({ origin: "scrub" })).toBe(true);
    expect(isStorageFinding({ origin: "verify" })).toBe(false);
    expect(isStorageFinding({ origin: null })).toBe(false);
  });

  it("picks the newer report", () => {
    const early = check("a", "green", 1, SNAPSHOT_N);
    const late = finding("b", 2);
    expect(newestOf(early, late)).toBe(late);
    expect(newestOf(late, early)).toBe(late);
    expect(newestOf(null, early)).toBe(early);
    expect(newestOf(early, null)).toBe(early);
    expect(newestOf(null, null)).toBeNull();
  });
});
