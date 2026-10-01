import { describe, expect, it } from "vitest";
import {
  type DatedSnapshot,
  applyRetentionPolicy,
  auditSnapshots,
  isoWeek,
  localDate,
} from "./retention-policy.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const id = (n: number) => n.toString(16).padStart(64, "0");

/** One snapshot a day, the newest `newest`. */
function daily(count: number, newest: Date): DatedSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: id(index + 1),
    time: new Date(newest.getTime() - index * DAY),
  }));
}

describe("calendar helpers", () => {
  it("reads the date in the tenant's time zone", () => {
    // 23:30 UTC is already the next day in Berlin.
    const late = new Date("2026-03-31T23:30:00Z");
    expect(localDate(late, "Europe/Berlin")).toEqual({ year: 2026, month: 4, day: 1 });
    expect(localDate(late, "UTC")).toEqual({ year: 2026, month: 3, day: 31 });
    // An unknown zone falls back to the default instead of failing.
    expect(localDate(late, "Mars/Olympus")).toEqual({ year: 2026, month: 4, day: 1 });
  });

  it("numbers weeks like ISO 8601 (and Go's ISOWeek)", () => {
    expect(isoWeek(2026, 1, 1)).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(2027, 1, 1)).toEqual({ year: 2026, week: 53 });
    expect(isoWeek(2024, 12, 30)).toEqual({ year: 2025, week: 1 });
    expect(isoWeek(2026, 10, 1)).toEqual({ year: 2026, week: 40 });
  });
});

describe("the retention policy, evaluated by the server", () => {
  const newest = new Date("2026-10-01T20:00:00Z");

  it("keeps the newest snapshot of each of the last N days", () => {
    const decision = applyRetentionPolicy(
      daily(5, newest),
      { keepDaily: 2, keepWeekly: 0, keepMonthly: 0 },
      "UTC",
    );
    expect(decision.keep).toEqual([id(1), id(2)]);
    expect(decision.remove).toEqual([id(3), id(4), id(5)]);
  });

  it("keeps only the newest of several snapshots on one day", () => {
    const snapshots = [0, 1, 2].map((n) => ({
      id: id(n + 1),
      time: new Date(newest.getTime() - n * HOUR),
    }));
    const decision = applyRetentionPolicy(
      snapshots,
      { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 },
      "UTC",
    );
    // The newest opens the day; the oldest is kept because the rule still has counts left.
    expect(decision.keep).toEqual([id(1), id(3)]);
    expect(decision.remove).toEqual([id(2)]);
  });

  it("keeps 30 daily, 12 weekly and 12 monthly snapshots of a year of daily backups", () => {
    const decision = applyRetentionPolicy(
      daily(400, newest),
      { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
      "Europe/Berlin",
    );
    const kept = new Set(decision.keep);
    for (let n = 1; n <= 30; n++) {
      expect(kept.has(id(n))).toBe(true);
    }
    expect(decision.keep.length).toBeGreaterThan(30);
    expect(decision.keep.length).toBeLessThanOrEqual(30 + 12 + 12 + 1);
    expect(decision.keep.length + decision.remove.length).toBe(400);
  });

  it("keeps everything when no rule keeps anything", () => {
    const decision = applyRetentionPolicy(daily(3, newest), {
      keepDaily: 0,
      keepWeekly: 0,
      keepMonthly: 0,
    });
    expect(decision.remove).toEqual([]);
    expect(decision.keep).toHaveLength(3);
  });
});

describe("which snapshots retention may decide on", () => {
  const now = new Date("2026-10-01T23:00:00Z");

  it("dates recorded snapshots by the server's facts, not by what the agent wrote", () => {
    const audit = auditSnapshots({
      stored: [{ id: id(1), storedAt: new Date("2026-09-30T22:10:00Z") }],
      recorded: [{ snapshotId: id(1), finishedAt: new Date("2026-09-30T22:11:00Z") }],
      claimed: [{ id: id(1), time: "2026-09-30T22:00:00+02:00" }],
      now,
    });
    expect(audit.dated).toEqual([{ id: id(1), time: new Date("2026-09-30T22:10:00Z") }]);
    expect(audit.unrecorded).toEqual([]);
    expect(audit.flags).toEqual([]);
  });

  it("leaves unrecorded snapshots out of the decision and flags them", () => {
    const audit = auditSnapshots({
      stored: [
        { id: id(1), storedAt: new Date("2026-09-30T22:10:00Z") },
        { id: id(2), storedAt: new Date("2026-10-01T10:00:00Z") },
      ],
      recorded: [{ snapshotId: id(1), finishedAt: null }],
      claimed: [],
      now,
    });
    expect(audit.dated.map((snapshot) => snapshot.id)).toEqual([id(1)]);
    expect(audit.unrecorded).toEqual([id(2)]);
    expect(audit.flags).toEqual([
      {
        id: id(2),
        reasons: ["unrecorded"],
        snapshotTime: null,
        storedAt: new Date("2026-10-01T10:00:00Z"),
      },
    ]);
  });

  it("flags a snapshot dated in the future or after its file was stored", () => {
    const storedAt = new Date("2026-10-01T10:00:00Z");
    const audit = auditSnapshots({
      stored: [
        { id: id(1), storedAt },
        { id: id(2), storedAt },
        { id: id(3), storedAt },
      ],
      recorded: [1, 2, 3].map((n) => ({ snapshotId: id(n), finishedAt: null })),
      claimed: [
        { id: id(1), time: "2027-01-01T00:00:00Z" },
        { id: id(2), time: "2026-10-01T13:00:00Z" },
        // Within the tolerance for a machine whose clock runs a little ahead.
        { id: id(3), time: "2026-10-01T10:30:00Z" },
      ],
      now,
    });
    expect(audit.flags.map((flag) => [flag.id, flag.reasons])).toEqual([
      [id(1), ["future_time"]],
      [id(2), ["future_time"]],
    ]);
    // A forged time decides nothing: every recorded snapshot is dated by its file.
    expect(audit.dated.every((snapshot) => snapshot.time.getTime() === storedAt.getTime())).toBe(
      true,
    );
  });

  it("matches a short recorded id only when exactly one snapshot starts with it", () => {
    const one = `abcdef01${"1".repeat(56)}`;
    const twinA = `12345678${"a".repeat(56)}`;
    const twinB = `12345678${"b".repeat(56)}`;
    const audit = auditSnapshots({
      stored: [one, twinA, twinB].map((snapshot) => ({ id: snapshot, storedAt: now })),
      recorded: [
        { snapshotId: "ABCDEF01", finishedAt: null },
        { snapshotId: "12345678", finishedAt: null },
      ],
      claimed: [],
      now,
    });
    expect(audit.dated.map((snapshot) => snapshot.id)).toEqual([one]);
    expect(audit.unrecorded.sort()).toEqual([twinA, twinB]);
  });

  it("takes the end of the run when it is earlier, so a copied storage folder does not make every snapshot new", () => {
    // The folder was copied today: every file carries the time of the copy.
    const copiedAt = new Date("2026-10-01T09:00:00Z");
    const runs = [1, 2, 3].map((n) => ({
      snapshotId: id(n),
      finishedAt: new Date(copiedAt.getTime() - n * DAY),
    }));
    const audit = auditSnapshots({
      stored: [1, 2, 3].map((n) => ({ id: id(n), storedAt: copiedAt })),
      recorded: runs,
      claimed: [],
      now,
    });
    expect(audit.dated.map((snapshot) => snapshot.time)).toEqual(runs.map((run) => run.finishedAt));
    const decision = applyRetentionPolicy(audit.dated, {
      keepDaily: 3,
      keepWeekly: 0,
      keepMonthly: 0,
    });
    expect(decision.remove).toEqual([]);
  });

  it("does not flag a snapshot stored in the last hour whose run has not reported yet", () => {
    const audit = auditSnapshots({
      stored: [
        { id: id(1), storedAt: new Date(now.getTime() - 10 * 60 * 1000) },
        { id: id(2), storedAt: new Date(now.getTime() - 2 * HOUR) },
      ],
      recorded: [],
      claimed: [],
      now,
    });
    // Neither is decided on; only the older one is suspicious.
    expect(audit.dated).toEqual([]);
    expect(audit.unrecorded).toEqual([id(1), id(2)]);
    expect(audit.flags.map((flag) => flag.id)).toEqual([id(2)]);
  });

  it("falls back to the end of the run when the storage does not say when a file came", () => {
    const finishedAt = new Date("2026-09-29T22:00:00Z");
    const audit = auditSnapshots({
      stored: [{ id: id(1), storedAt: null }],
      recorded: [{ snapshotId: id(1).toUpperCase(), finishedAt }],
      claimed: [],
      now,
    });
    expect(audit.dated).toEqual([{ id: id(1), time: finishedAt }]);
  });

  it("defeats the forged-snapshot attack: 30 snapshots dated in the future delete nothing genuine", () => {
    const genuine = daily(10, new Date("2026-10-01T20:00:00Z"));
    // The attacker's snapshots: stored two hours ago, no run reported them, dated years ahead.
    const forged = Array.from({ length: 30 }, (_, n) => ({
      id: id(1000 + n),
      storedAt: new Date(now.getTime() - 2 * HOUR),
    }));
    const audit = auditSnapshots({
      stored: [
        ...genuine.map((snapshot) => ({ id: snapshot.id, storedAt: snapshot.time })),
        ...forged,
      ],
      recorded: genuine.map((snapshot) => ({ snapshotId: snapshot.id, finishedAt: snapshot.time })),
      claimed: forged.map((snapshot, n) => ({
        id: snapshot.id,
        time: new Date(Date.UTC(2030, 0, 1 + n)).toISOString(),
      })),
      now,
    });
    const decision = applyRetentionPolicy(audit.dated, {
      keepDaily: 30,
      keepWeekly: 12,
      keepMonthly: 12,
    });
    expect(decision.remove).toEqual([]);
    expect(decision.keep.sort()).toEqual(genuine.map((snapshot) => snapshot.id).sort());
    expect(audit.unrecorded).toHaveLength(30);
    expect(audit.flags.every((flag) => flag.reasons.includes("unrecorded"))).toBe(true);
    expect(audit.flags.every((flag) => flag.reasons.includes("future_time"))).toBe(true);
  });
});
