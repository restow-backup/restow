import { describe, expect, it } from "vitest";
import {
  type SnapshotCandidate,
  type SnapshotRetentionPolicy,
  groupByObject,
  resolvePolicyFor,
  selectExpiredSnapshots,
} from "./selection.js";
import { DEFAULT_TIERS } from "./tiers.js";

const OBJECT_A = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const OBJECT_B = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const NOW = new Date("2026-06-01T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function candidate(
  id: string,
  sequence: number,
  ageDays: number | null,
  overrides: Partial<SnapshotCandidate> = {},
): SnapshotCandidate {
  return {
    id,
    protectedObjectId: OBJECT_A,
    sequence,
    byteSize: 1000 * sequence,
    completedAt: ageDays === null ? null : daysAgo(ageDays),
    verified: false,
    ...overrides,
  };
}

const flat30: SnapshotRetentionPolicy = {
  policyId: "p30",
  tiers: [{ fromDays: 0, toDays: 30, keepEveryDays: 0 }],
  protectedObjectIds: null,
  isDefault: true,
};

describe("resolvePolicyFor", () => {
  const scoped: SnapshotRetentionPolicy = {
    ...flat30,
    policyId: "scoped",
    protectedObjectIds: [OBJECT_B],
    isDefault: false,
  };
  const fallback: SnapshotRetentionPolicy = { ...flat30, policyId: "first", isDefault: false };

  it("prefers an object-scoped policy, then the default, then the first tenant-wide one", () => {
    expect(resolvePolicyFor([fallback, scoped, flat30], OBJECT_B)?.policyId).toBe("scoped");
    expect(resolvePolicyFor([fallback, scoped, flat30], OBJECT_A)?.policyId).toBe("p30");
    expect(resolvePolicyFor([fallback, scoped], OBJECT_A)?.policyId).toBe("first");
    expect(resolvePolicyFor([scoped], OBJECT_A)).toBeNull();
  });
});

describe("groupByObject", () => {
  it("groups by object, preserving encounter order", () => {
    const groups = groupByObject([
      candidate("a1", 1, 1),
      { ...candidate("b1", 1, 1), protectedObjectId: OBJECT_B },
      candidate("a2", 2, 1),
    ]);
    expect([...groups.keys()]).toEqual([OBJECT_A, OBJECT_B]);
    expect(groups.get(OBJECT_A)?.map((c) => c.id)).toEqual(["a1", "a2"]);
  });
});

describe("selectExpiredSnapshots — flat cutoff", () => {
  it("prunes past the cutoff, but never the newest restore point", () => {
    const history = [
      candidate("s1", 1, 100), // oldest, past cutoff
      candidate("s2", 2, 45), // past cutoff
      candidate("s3", 3, 10), // within cutoff
      candidate("s4", 4, 60), // newest by sequence, despite its age
    ];
    expect(
      selectExpiredSnapshots(history, flat30, NOW)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["s1", "s2"]);
  });

  it("keeps everything within an open-ended tier", () => {
    const keepAll: SnapshotRetentionPolicy = {
      ...flat30,
      tiers: [{ fromDays: 0, toDays: null, keepEveryDays: 0 }],
    };
    const history = [candidate("s1", 1, 400), candidate("s2", 2, null), candidate("s3", 3, 1)];
    expect(selectExpiredSnapshots(history, keepAll, NOW)).toEqual([]);
  });

  it("never selects a restore point still without a completion time", () => {
    const history = [candidate("s1", 1, null), candidate("s2", 2, 1)];
    expect(selectExpiredSnapshots(history, flat30, NOW)).toEqual([]);
  });
});

describe("selectExpiredSnapshots — guards", () => {
  it("never prunes the object's only verified restore point, even past the cutoff", () => {
    const history = [
      candidate("v1", 1, 100, { verified: true }), // sole verified, not the newest
      candidate("v2", 2, 50), // newest, also past cutoff
    ];
    expect(selectExpiredSnapshots(history, flat30, NOW)).toEqual([]);
  });

  it("keeps the newest verified restore point even when another one is also verified", () => {
    const history = [
      candidate("v1", 1, 100, { verified: true }), // older verified, past cutoff, pruned
      candidate("v2", 2, 80, { verified: true }), // newest verified, protected despite its age
      candidate("v3", 3, 5), // newest overall, survives on its own too
    ];
    expect(
      selectExpiredSnapshots(history, flat30, NOW)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["v1"]);
  });

  it("never prunes every verified restore point, even when all of them are past the cutoff", () => {
    const history = [
      candidate("v1", 1, 400, { verified: true }), // older verified, past cutoff, pruned
      candidate("v2", 2, 200, { verified: true }), // newest verified, protected despite its age
      candidate("n1", 3, 1), // newest overall, unverified, survives on its own
    ];
    expect(
      selectExpiredSnapshots(history, flat30, NOW)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["v1"]);
  });
});

describe("selectExpiredSnapshots — legacy keepLast", () => {
  it("keeps the newest N restore points regardless of age, for a legacy row's own keepLast", () => {
    const policy: SnapshotRetentionPolicy = { ...flat30, keepLast: 3 };
    const history = [
      candidate("s1", 1, 500), // past cutoff, outside the newest 3
      candidate("s2", 2, 400), // past cutoff, but within the newest 3: kept
      candidate("s3", 3, 200), // within the newest 3: kept
      candidate("s4", 4, 10), // newest, within cutoff anyway
    ];
    expect(selectExpiredSnapshots(history, policy, NOW).map((c) => c.id)).toEqual(["s1"]);
  });

  it("without keepLast, only the newest restore point is guarded (matches keepLast undefined/1)", () => {
    const history = [candidate("s1", 1, 500), candidate("s2", 2, 400), candidate("s3", 3, 10)];
    expect(
      selectExpiredSnapshots(history, flat30, NOW)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["s1", "s2"]);
  });
});

describe("selectExpiredSnapshots — tiered (default) rule", () => {
  it("keeps every point 30 days, thins to one a day to 90, one a week to a year, prunes beyond", () => {
    const history = [
      candidate("a1", 1, 400), // past every tier
      candidate("a2", 2, 300), // weekly tier, alone in its bucket
      candidate("a3", 3, 91), // weekly tier, same bucket as a4
      candidate("a4", 4, 95), // weekly tier, same bucket as a3, newer sequence survives
      candidate("a5", 5, 20), // daily-keep-all tier
      candidate("a6", 6, 2), // newest, daily-keep-all tier
    ];
    expect(
      selectExpiredSnapshots(history, { ...flat30, tiers: DEFAULT_TIERS }, NOW)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["a1", "a3"]);
  });

  it("thins the daily tier to its newest restore point per day", () => {
    const history = [
      candidate("d1", 1, 35), // day bucket (35-30)=5
      candidate("d2", 2, 35, { protectedObjectId: OBJECT_A }), // same day bucket, newer sequence
      candidate("d3", 3, 1), // newest, unaffected
    ];
    const expired = selectExpiredSnapshots(history, { ...flat30, tiers: DEFAULT_TIERS }, NOW);
    expect(expired.map((c) => c.id)).toEqual(["d1"]);
  });
});

describe("selectExpiredSnapshots — tiered rule over repeated runs", () => {
  const START = new Date("2024-01-01T00:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  /**
   * A survivor's bucket must stay the same run after run, or a thinning tier
   * collapses to a single lifetime survivor instead of "one per N days"
   * (regression for the bug where buckets were keyed off age relative to
   * `now` instead of the restore point's own calendar day).
   */
  function simulate(intervalMs: number, totalDays: number): SnapshotCandidate[] {
    const policy: SnapshotRetentionPolicy = { ...flat30, tiers: DEFAULT_TIERS };
    let alive: SnapshotCandidate[] = [];
    let sequence = 0;
    let elapsed = 0;
    let nextRunDay = 1;
    while (elapsed <= totalDays * DAY) {
      sequence += 1;
      alive.push({
        id: `s${sequence}`,
        protectedObjectId: OBJECT_A,
        sequence,
        byteSize: 1,
        completedAt: new Date(START.getTime() + elapsed),
        verified: false,
      });
      // Run retention once per simulated day, using the latest backup's time as "now".
      if (elapsed >= nextRunDay * DAY) {
        const now = new Date(START.getTime() + elapsed);
        const expired = new Set(selectExpiredSnapshots(alive, policy, now).map((c) => c.id));
        alive = alive.filter((c) => !expired.has(c.id));
        nextRunDay += 1;
      }
      elapsed += intervalMs;
    }
    return alive;
  }

  function countInAgeRange(
    alive: SnapshotCandidate[],
    endOfSim: Date,
    fromDays: number,
    toDays: number,
  ): number {
    return alive.filter((c) => {
      if (!c.completedAt) return false;
      const age = Math.floor((endOfSim.getTime() - c.completedAt.getTime()) / DAY);
      return age >= fromDays && age < toDays;
    }).length;
  }

  it("keeps roughly one restore point per day in 30-90d and one per week in 90-365d, for daily backups over 500 days", () => {
    const totalDays = 500;
    const alive = simulate(DAY, totalDays);
    const endOfSim = new Date(START.getTime() + totalDays * DAY);
    const daily = countInAgeRange(alive, endOfSim, 30, 90);
    const weekly = countInAgeRange(alive, endOfSim, 90, 365);
    // 60 days of daily thinning, 275 days of weekly thinning; allow a little
    // slack for bucket-boundary effects.
    expect(daily).toBeGreaterThanOrEqual(55);
    expect(daily).toBeLessThanOrEqual(62);
    expect(weekly).toBeGreaterThanOrEqual(35);
    expect(weekly).toBeLessThanOrEqual(42);
    // Nothing survives past the policy's one-year cutoff.
    expect(
      alive.every((c) => c.completedAt && endOfSim.getTime() - c.completedAt.getTime() < 365 * DAY),
    ).toBe(true);
  });

  it("still keeps a weekly survivor past 30 days when backups run every 5 hours", () => {
    const totalDays = 200;
    const alive = simulate(5 * HOUR, totalDays);
    const endOfSim = new Date(START.getTime() + totalDays * DAY);
    const weekly = countInAgeRange(alive, endOfSim, 90, 200);
    expect(weekly).toBeGreaterThan(1);
  });
});
