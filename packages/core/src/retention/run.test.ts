import { describe, expect, it } from "vitest";
import { type LegalHoldScope, NO_HOLDS } from "./holds.js";
import { planRetentionRun, totalBytes } from "./run.js";
import type { SnapshotCandidate, SnapshotRetentionPolicy } from "./selection.js";

const OBJECT_A = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const OBJECT_B = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const NOW = new Date("2026-06-01T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function candidate(
  id: string,
  protectedObjectId: string,
  sequence: number,
  ageDays: number,
): SnapshotCandidate {
  return {
    id,
    protectedObjectId,
    sequence,
    byteSize: 1000 * sequence,
    completedAt: daysAgo(ageDays),
    verified: false,
  };
}

const flat30: SnapshotRetentionPolicy = {
  policyId: "p30",
  tiers: [{ fromDays: 0, toDays: 30, keepEveryDays: 0 }],
  protectedObjectIds: null,
  isDefault: true,
};

describe("planRetentionRun", () => {
  it("keeps everything when no policy resolves for an object", () => {
    const plan = planRetentionRun([candidate("a1", OBJECT_A, 1, 100)], [], NO_HOLDS, NOW);
    expect(plan).toMatchObject({
      objectsEvaluated: 1,
      candidatesConsidered: 0,
      expired: [],
      held: [],
    });
  });

  it("expires what the policy no longer requires, across every object it covers", () => {
    const history = [
      candidate("a1", OBJECT_A, 1, 100),
      candidate("a2", OBJECT_A, 2, 5),
      candidate("b1", OBJECT_B, 1, 100),
      candidate("b2", OBJECT_B, 2, 5),
    ];
    const plan = planRetentionRun(history, [flat30], NO_HOLDS, NOW);
    expect(plan.objectsEvaluated).toBe(2);
    expect(plan.candidatesConsidered).toBe(4);
    expect(plan.expired.map((c) => c.id).sort()).toEqual(["a1", "b1"]);
    expect(plan.held).toEqual([]);
  });

  it("sets aside restore points a legal hold currently suspends, tenant-wide or per object", () => {
    const history = [
      candidate("a1", OBJECT_A, 1, 100),
      candidate("a2", OBJECT_A, 2, 5),
      candidate("b1", OBJECT_B, 1, 100),
      candidate("b2", OBJECT_B, 2, 5),
    ];
    const perObject: LegalHoldScope = {
      tenantWide: false,
      protectedObjectIds: new Set([OBJECT_A]),
    };
    const plan = planRetentionRun(history, [flat30], perObject, NOW);
    expect(plan.expired.map((c) => c.id)).toEqual(["b1"]);
    expect(plan.held.map((c) => c.id)).toEqual(["a1"]);

    const tenantWide: LegalHoldScope = { tenantWide: true, protectedObjectIds: new Set() };
    const heldEverywhere = planRetentionRun(history, [flat30], tenantWide, NOW);
    expect(heldEverywhere.expired).toEqual([]);
    expect(heldEverywhere.held.map((c) => c.id).sort()).toEqual(["a1", "b1"]);
  });
});

describe("totalBytes", () => {
  it("sums the byte size of a list of restore points", () => {
    expect(totalBytes([candidate("a1", OBJECT_A, 1, 1), candidate("a2", OBJECT_A, 2, 1)])).toBe(
      1000 + 2000,
    );
    expect(totalBytes([])).toBe(0);
  });
});
