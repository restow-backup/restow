import { describe, expect, it } from "vitest";
import {
  aggregateReadiness,
  countReadinessStates,
  isRecoveryReadiness,
  READINESS_CATEGORIES,
  READINESS_CATEGORY_OF_STATE,
  READINESS_CATEGORY_SEVERITY,
  type ReadinessObjectState,
  type ReadinessStateCounts,
} from "./readiness-aggregate.js";

/**
 * The cases of the aggregate rule (UI rework, decision 1). The web mirror
 * (apps/web/src/components/kit/status-meta.test.ts) tests the same table.
 */
export const AGGREGATE_VECTORS: ReadonlyArray<{
  name: string;
  counts: ReadinessStateCounts;
  rated: number;
  expected: "green" | "yellow" | "red" | null;
}> = [
  {
    name: "the brief's case 0/0/1/1/18 reads Not proven",
    counts: { green: 1, yellow: 1, red: 0, unverified: 18, noBackup: 0 },
    rated: 20,
    expected: "yellow",
  },
  {
    name: "a not restorable object",
    counts: { green: 1, yellow: 0, red: 1, unverified: 0, noBackup: 0 },
    rated: 2,
    expected: "red",
  },
  {
    name: "an object without a backup",
    counts: { green: 1, yellow: 0, red: 0, unverified: 0, noBackup: 1 },
    rated: 2,
    expected: "red",
  },
  {
    name: "no backup yet beats everything below it",
    counts: { green: 1, yellow: 5, red: 0, unverified: 5, noBackup: 1 },
    rated: 12,
    expected: "red",
  },
  {
    name: "an unverified object",
    counts: { green: 1, yellow: 0, red: 0, unverified: 1, noBackup: 0 },
    rated: 2,
    expected: "yellow",
  },
  {
    name: "an object that needs attention",
    counts: { green: 1, yellow: 1, red: 0, unverified: 0, noBackup: 0 },
    rated: 2,
    expected: "yellow",
  },
  {
    name: "ready objects only",
    counts: { green: 3, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
    rated: 3,
    expected: "green",
  },
  {
    name: "confirmed-empty objects only",
    counts: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
    rated: 1,
    expected: "green",
  },
  {
    name: "nothing to rate",
    counts: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
    rated: 0,
    expected: null,
  },
];

const STATES: readonly ReadinessObjectState[] = [
  "green",
  "yellow",
  "unverified",
  "red",
  "no_backup",
  "empty",
];

describe("aggregateReadiness", () => {
  it.each(AGGREGATE_VECTORS)("$name -> $expected", ({ counts, rated, expected }) => {
    expect(aggregateReadiness(counts, rated)).toBe(expected);
  });

  it("gives the same result from counted states", () => {
    const states: ReadinessObjectState[] = [
      "green",
      "yellow",
      ...Array.from({ length: 18 }, () => "unverified" as const),
    ];
    const counts = countReadinessStates(states);
    expect(counts).toEqual({
      green: 1,
      yellow: 1,
      red: 0,
      unverified: 18,
      noBackup: 0,
      empty: 0,
      total: 20,
    });
    expect(aggregateReadiness(counts, counts.total)).toBe("yellow");
  });

  it("counts empty objects as rated, not as green", () => {
    const counts = countReadinessStates(["empty", "empty"]);
    expect(counts).toMatchObject({ green: 0, empty: 2, total: 2 });
    expect(aggregateReadiness(counts, counts.total)).toBe("green");
  });
});

describe("category maps", () => {
  it("gives every object state a category, and only empty none", () => {
    expect(Object.keys(READINESS_CATEGORY_OF_STATE).sort()).toEqual([...STATES].sort());
    for (const state of STATES) {
      const category = READINESS_CATEGORY_OF_STATE[state];
      if (state === "empty") {
        expect(category).toBeNull();
      } else {
        expect(READINESS_CATEGORIES).toContain(category);
      }
    }
    const categories = STATES.map((state) => READINESS_CATEGORY_OF_STATE[state]).filter(
      (category) => category !== null,
    );
    expect(new Set(categories).size).toBe(READINESS_CATEGORIES.length);
  });

  it("gives every category a severity, attention apart from warning", () => {
    expect(Object.keys(READINESS_CATEGORY_SEVERITY).sort()).toEqual(
      [...READINESS_CATEGORIES].sort(),
    );
    expect(READINESS_CATEGORY_SEVERITY.needs_attention).toBe("attention");
    expect(READINESS_CATEGORY_SEVERITY.unverified).toBe("warning");
    expect(READINESS_CATEGORY_SEVERITY.not_restorable).toBe("danger");
    expect(READINESS_CATEGORY_SEVERITY.no_backup).toBe("danger");
    expect(READINESS_CATEGORY_SEVERITY.ready).toBe("success");
  });
});

describe("isRecoveryReadiness", () => {
  it("accepts the three ratings only", () => {
    expect(["green", "yellow", "red"].every(isRecoveryReadiness)).toBe(true);
    for (const value of ["unverified", "bogus", "", null, undefined, 1, {}]) {
      expect(isRecoveryReadiness(value)).toBe(false);
    }
  });
});
