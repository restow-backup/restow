import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import { parseOrProblem } from "../../schemas.js";
import {
  INVALID_SCHEDULE_PROBLEM,
  applyRecommendedSchema,
  assertCadenceOrProblem,
  createScheduleSchema,
  previewScheduleSchema,
  scheduleProblem,
  updateScheduleSchema,
} from "./schemas.js";

const NOW = new Date("2026-03-01T10:00:00Z");
const OBJECT_ID = "3f0c2a9e-2f1b-4c1d-9a6e-5b7c8d9e0f1a";

/** The problem a call throws, or a failure when it does not throw one. */
function problemOf(run: () => unknown): ProblemError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProblemError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a problem");
}

describe("createScheduleSchema", () => {
  it("fills the defaults: every object, Berlin time, switched on", () => {
    expect(createScheduleSchema.parse({ kind: "backup", intervalMinutes: 480 })).toEqual({
      kind: "backup",
      protectedObjectId: null,
      intervalMinutes: 480,
      cron: undefined,
      timezone: "Europe/Berlin",
      enabled: true,
    });
  });

  it("keeps a scope, a trimmed cron expression and a blank cron as not set", () => {
    expect(
      createScheduleSchema.parse({
        kind: "verify",
        protectedObjectId: OBJECT_ID,
        cron: "  0 3 * * 0 ",
        timezone: "UTC",
        enabled: false,
      }),
    ).toMatchObject({ protectedObjectId: OBJECT_ID, cron: "0 3 * * 0", enabled: false });
    expect(createScheduleSchema.parse({ kind: "backup", cron: "  " }).cron).toBeNull();
  });

  it("does not offer archive schedules and rejects unknown fields", () => {
    const archive = problemOf(() =>
      parseOrProblem(createScheduleSchema, { kind: "archive", intervalMinutes: 60 }),
    );
    expect(archive.status).toBe(422);
    expect(JSON.stringify(archive.extensions)).toContain('"path":["kind"]');
    expect(
      createScheduleSchema.safeParse({ kind: "backup", intervalMinutes: 60, nextRunAt: "x" })
        .success,
    ).toBe(false);
  });
});

describe("updateScheduleSchema", () => {
  it("needs at least one change and never changes the kind", () => {
    expect(updateScheduleSchema.safeParse({}).success).toBe(false);
    expect(updateScheduleSchema.safeParse({ kind: "scrub" }).success).toBe(false);
    expect(updateScheduleSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateScheduleSchema.parse({ cron: null })).toEqual({ cron: null });
  });
});

describe("previewScheduleSchema and applyRecommendedSchema", () => {
  it("default the zone to Europe/Berlin", () => {
    expect(previewScheduleSchema.parse({ cron: "0 3 * * *" }).timezone).toBe("Europe/Berlin");
    expect(applyRecommendedSchema.parse({})).toEqual({ timezone: "Europe/Berlin" });
    expect(applyRecommendedSchema.parse({ timezone: "America/New_York" }).timezone).toBe(
      "America/New_York",
    );
  });
});

describe("cadence problems", () => {
  it("are 422 problems that name the field in `field` and in the issue path", () => {
    const problem = scheduleProblem("cron", "cron_invalid", "Not a five-field cron expression.");
    expect(problem.status).toBe(422);
    expect(problem.type).toBe(INVALID_SCHEDULE_PROBLEM);
    expect(problem.extensions).toMatchObject({
      field: "cron",
      code: "cron_invalid",
      issues: [{ path: ["cron"], code: "cron_invalid" }],
    });
  });

  it("name the cron field, the zone and the interval/cron combination", () => {
    const cases: [Parameters<typeof assertCadenceOrProblem>[0], string, string][] = [
      [{ cron: "0 25 * * *", timezone: "UTC" }, "cron", "cron_invalid"],
      [{ cron: "0 3 * * *", timezone: "Europe/Nowhere" }, "timezone", "timezone_unknown"],
      [
        { intervalMinutes: 60, cron: "0 3 * * *", timezone: "UTC" },
        "intervalMinutes",
        "cadence_ambiguous",
      ],
      [{ timezone: "UTC" }, "intervalMinutes", "cadence_missing"],
      [{ intervalMinutes: 5, timezone: "UTC" }, "intervalMinutes", "interval_out_of_range"],
    ];
    for (const [cadence, field, code] of cases) {
      const problem = problemOf(() => assertCadenceOrProblem(cadence, NOW));
      expect(problem.extensions, JSON.stringify(cadence)).toMatchObject({ field, code });
      expect(problem.detail).toMatch(new RegExp(`^${field}: `));
    }
    expect(() =>
      assertCadenceOrProblem({ intervalMinutes: 480, timezone: "Europe/Berlin" }, NOW),
    ).not.toThrow();
  });
});
