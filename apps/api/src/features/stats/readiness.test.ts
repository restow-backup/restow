import { describe, expect, it } from "vitest";
import type { ReadinessObject, ReadinessReport, ReadinessSnapshot } from "./facts.js";
import { ReadinessTimeline, countedTotal, isProtected, provenCount } from "./readiness.js";

/** Midnight UTC of a September day, plus hours. */
const day = (n: number, hour = 0) => new Date(Date.UTC(2026, 8, n, hour));

function object(
  id: string,
  createdDay: number,
  status: ReadinessObject["status"] = "active",
): ReadinessObject {
  return { id, name: id, kind: "mailbox", status, createdAt: day(createdDay) };
}

function snapshot(
  objectId: string,
  sequence: number,
  completedDay: number,
  prunedDay: number | null = null,
): ReadinessSnapshot {
  return {
    id: `${objectId}-${sequence}`,
    objectId,
    sequence,
    completedAt: day(completedDay, 12),
    prunedAt: prunedDay === null ? null : day(prunedDay, 12),
  };
}

let reportCount = 0;

/** A restore check of one snapshot (`objectId-sequence`), or of none when `sequence` is null. */
function check(
  objectId: string,
  sequence: number | null,
  checkedDay: number,
  readiness: ReadinessReport["readiness"],
): ReadinessReport {
  reportCount += 1;
  return {
    id: `r${reportCount}`,
    objectId,
    snapshotId: sequence === null ? null : `${objectId}-${sequence}`,
    origin: "verify",
    readiness,
    checkedAt: day(checkedDay, 18),
    createdAt: day(checkedDay, 18),
  };
}

/** A storage finding (scrub): damage in the object's data, no snapshot named. */
function finding(objectId: string, checkedDay: number): ReadinessReport {
  reportCount += 1;
  return {
    id: `r${reportCount}`,
    objectId,
    snapshotId: null,
    origin: "scrub",
    readiness: "red",
    checkedAt: day(checkedDay, 20),
    createdAt: day(checkedDay, 20),
  };
}

describe("ReadinessTimeline", () => {
  it("rates an object by the check of its newest backup, not by its newest check", () => {
    const timeline = new ReadinessTimeline(
      [object("anna", 1)],
      [snapshot("anna", 1, 2), snapshot("anna", 2, 5), snapshot("anna", 3, 9)],
      [check("anna", 1, 3, "green"), check("anna", 3, 10, "yellow")],
    );
    expect(timeline.at(day(3)).states.get("anna")).toBe("unverified");
    expect(timeline.at(day(4)).states.get("anna")).toBe("green");
    // A newer backup than the green check: unverified until a check of that backup ran.
    const afterNewBackup = timeline.at(day(6));
    expect(afterNewBackup.states.get("anna")).toBe("unverified");
    expect(afterNewBackup.counts).toEqual({ green: 0, yellow: 0, red: 0, unverified: 1 });
    expect(afterNewBackup.overall).toBe("red");
    // The check of backup 3 rates it once it ran; backup 2 was never checked, that is history.
    expect(timeline.at(day(10)).states.get("anna")).toBe("unverified");
    expect(timeline.at(day(11)).states.get("anna")).toBe("yellow");
  });

  it("lets no check without a snapshot rate a backup", () => {
    const timeline = new ReadinessTimeline(
      [object("anna", 1)],
      [snapshot("anna", 1, 2)],
      [check("anna", null, 3, "green")],
    );
    expect(timeline.at(day(10)).states.get("anna")).toBe("unverified");
  });

  it("rates a backup red when the storage check found damage after its check", () => {
    const timeline = new ReadinessTimeline(
      [object("dora", 1), object("emil", 1), object("ida", 1)],
      [snapshot("dora", 1, 2), snapshot("emil", 1, 2), snapshot("ida", 1, 2)],
      [
        check("dora", 1, 3, "green"),
        finding("dora", 6),
        // Checked after the damage was found: the check already accounted for it.
        finding("emil", 3),
        check("emil", 1, 4, "yellow"),
        // Never checked, but damaged.
        finding("ida", 5),
      ],
    );
    const before = timeline.at(day(6));
    expect(before.states.get("dora")).toBe("green");
    expect(before.states.get("ida")).toBe("red");
    const after = timeline.at(day(7));
    expect(after.states.get("dora")).toBe("red");
    expect(after.states.get("emil")).toBe("yellow");
    expect(after.counts).toEqual({ green: 0, yellow: 1, red: 2, unverified: 0 });
  });

  it("knows no backup before the first one completed, and none after all were pruned", () => {
    const timeline = new ReadinessTimeline(
      [object("carl", 1), object("gone", 1, "orphaned")],
      [snapshot("gone", 1, 2, 8)],
      [check("gone", 1, 3, "green")],
    );
    const early = timeline.at(day(2));
    expect(early.states.get("carl")).toBe("no_backup");
    // An object without a backup is not proven: it counts as unverified.
    expect(early.counts.unverified).toBe(1);
    expect(early.total).toBe(1);
    // The orphan counts while it has a backup ...
    expect(timeline.at(day(5)).states.get("gone")).toBe("green");
    expect(timeline.at(day(5)).total).toBe(2);
    // ... and not once its last backup is gone.
    expect(timeline.at(day(9)).states.get("gone")).toBe("no_backup");
    expect(timeline.at(day(9)).total).toBe(1);
  });

  it("takes the highest sequence as the newest backup and skips pruned ones", () => {
    const timeline = new ReadinessTimeline(
      [object("anna", 1)],
      // Completed out of order: sequence 2 finished before sequence 1.
      [snapshot("anna", 2, 3), snapshot("anna", 1, 4), snapshot("anna", 3, 6, 7)],
      [],
    );
    expect(timeline.latestSnapshotAt("anna", day(3))).toBeNull();
    expect(timeline.latestSnapshotAt("anna", day(5))?.sequence).toBe(2);
    expect(timeline.latestSnapshotAt("anna", day(7))?.sequence).toBe(3);
    // Pruned (against retention's own rule) after day 7: the next one stands in.
    expect(timeline.latestSnapshotAt("anna", day(8))?.sequence).toBe(2);
    expect(timeline.latestSnapshotAt("nobody", day(8))).toBeNull();
  });

  it("leaves out objects that did not exist yet, excluded ones, and orphans without a backup", () => {
    const timeline = new ReadinessTimeline(
      [
        object("anna", 1),
        object("dora", 10),
        object("left", 1, "excluded"),
        object("lost", 1, "orphaned"),
      ],
      [snapshot("anna", 1, 2), snapshot("left", 1, 2)],
      [check("anna", 1, 3, "green"), check("left", 1, 3, "green")],
    );
    const moment = timeline.at(day(12));
    // The excluded object keeps a state (it still has backups) but is not counted.
    expect(moment.states.get("left")).toBe("green");
    expect(moment.states.get("dora")).toBe("no_backup");
    expect(countedTotal(moment.counts)).toBe(2);
    expect(moment.total).toBe(2);
    expect(timeline.at(day(5)).states.has("dora")).toBe(false);
  });

  it("rates a tenant yellow when every backup is fine but its check is overdue", () => {
    const fine = new ReadinessTimeline(
      [object("anna", 1)],
      [snapshot("anna", 1, 2)],
      [check("anna", 1, 3, "green")],
    );
    expect(fine.at(day(5)).overall).toBe("green");
    expect(fine.at(day(20)).overall).toBe("yellow");
    expect(new ReadinessTimeline([], [], []).at(day(20)).overall).toBeNull();
  });
});

describe("counting", () => {
  it("counts green and yellow as proven restorable", () => {
    expect(provenCount({ green: 2, yellow: 1, red: 3, unverified: 4 })).toBe(3);
  });

  it("protects active objects, and orphaned ones while they have a backup", () => {
    expect(isProtected("active", false)).toBe(true);
    expect(isProtected("orphaned", true)).toBe(true);
    expect(isProtected("orphaned", false)).toBe(false);
    expect(isProtected("excluded", true)).toBe(false);
  });
});
