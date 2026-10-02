import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import {
  cadenceProblemOf,
  conflictsOf,
  isInvalidJob,
  isPauseNotSupported,
  jobErrorKey,
  jobProblemOf,
  problemTarget,
} from "./problems.js";

function problem(status: number, body: Record<string, unknown>): ApiError {
  return new ApiError(status, { type: "about:blank", title: "x", status, ...body }, "failed");
}

describe("a refused job", () => {
  const refused = problem(422, {
    type: "urn:restow:problem:invalid-backup-job",
    field: "schedule",
    code: "timezone_unknown",
    issues: [{ path: ["schedule", "timeZone"], code: "timezone_unknown", message: "no such zone" }],
  });

  it("names the field the way the server does: issues[0].path, code and message", () => {
    expect(jobProblemOf(refused)).toEqual({
      path: ["schedule", "timeZone"],
      code: "timezone_unknown",
      message: "no such zone",
    });
    expect(isInvalidJob(refused)).toBe(true);
  });

  it("falls back to the field when the issue has no path, and ignores everything else", () => {
    expect(jobProblemOf(problem(422, { field: "name" }))).toMatchObject({
      path: ["name"],
      code: "invalid",
    });
    expect(jobProblemOf(problem(422, {}))).toBeNull();
    expect(jobProblemOf(problem(409, { field: "name" }))).toBeNull();
    expect(jobProblemOf(new Error("x"))).toBeNull();
  });

  it("finds the editor field of a path", () => {
    expect(problemTarget(["name"])).toBe("name");
    expect(problemTarget(["schedule", "timeOfDay"])).toBe("schedule");
    expect(problemTarget(["verifySchedule", "cron"])).toBe("verifySchedule");
    expect(problemTarget(["settings", "paths"])).toBe("paths");
    expect(problemTarget(["settings", "paths", "2"])).toBe("paths");
    expect(problemTarget(["settings", "excludes"])).toBe("excludes");
    expect(problemTarget(["settings", "excludeLargerThanGib"])).toBe("larger");
    expect(problemTarget(["settings", "bandwidthKbps"])).toBe("bandwidth");
    expect(problemTarget(["settings", "hooks", "pre"])).toBe("hooks");
    expect(problemTarget(["settings", "retention", "keepDaily"])).toBe("retention");
    expect(problemTarget(["retentionPolicyId"])).toBe("retentionPolicy");
    expect(problemTarget(["scope", "members"])).toBe("scope");
    expect(problemTarget(["storageTargetId"])).toBe("general");
  });

  it("hands the cadence fields the part of the schedule that is wrong, in the schedules' words", () => {
    const cron = problem(422, {
      issues: [{ path: ["schedule", "cron"], code: "cron_invalid", message: "bad" }],
    });
    expect(cadenceProblemOf(jobProblemOf(cron), "schedule")).toEqual({
      field: "cron",
      key: "problems.cron_invalid",
    });
    expect(cadenceProblemOf(jobProblemOf(cron), "verifySchedule")).toBeNull();
    const odd = problem(422, {
      issues: [
        { path: ["verifySchedule", "kind"], code: "schedule_kind_not_supported", message: "no" },
      ],
    });
    expect(cadenceProblemOf(jobProblemOf(odd), "verifySchedule")).toEqual({
      field: "kind",
      key: "problems.generic",
    });
  });
});

describe("other refusals", () => {
  it("lists the objects that belong to another job", () => {
    const conflict = problem(409, {
      type: "urn:restow:problem:backup-job-member-in-other-job",
      conflicts: [
        { targetId: "m1", jobId: "j1", jobName: "Servers" },
        { targetId: 5, jobId: "j2", jobName: "bad entry" },
      ],
    });
    expect(conflictsOf(conflict)).toEqual([{ targetId: "m1", jobId: "j1", jobName: "Servers" }]);
    expect(conflictsOf(problem(409, { type: "urn:restow:problem:other" }))).toBeNull();
    expect(
      conflictsOf(problem(422, { type: "urn:restow:problem:backup-job-member-in-other-job" })),
    ).toBeNull();
    expect(jobErrorKey(conflict)).toBe("backupjobs:errors.inOtherJob");
  });

  it("knows that a machine job cannot be paused", () => {
    const pause = problem(422, {
      issues: [{ path: ["enabled"], code: "pause_not_supported", message: "no" }],
    });
    expect(isPauseNotSupported(pause)).toBe(true);
    expect(jobErrorKey(pause)).toBe("backupjobs:errors.pauseNotSupported");
  });

  it("words a second job that covers everything, and any other state problem", () => {
    expect(
      jobErrorKey(
        problem(409, { type: "urn:restow:problem:backup-job-state", code: "all_job_exists" }),
      ),
    ).toBe("backupjobs:errors.allJobExists");
    expect(jobErrorKey(problem(409, { type: "urn:restow:problem:backup-job-state" }))).toBe(
      "backupjobs:errors.state",
    );
  });

  it("words the hook problems and the step-up like the machine page does", () => {
    expect(
      jobErrorKey(problem(409, { type: "urn:restow:problem:endpoint-hooks-not-allowed" })),
    ).toBe("endpoints:errors.hooksNotAllowed");
    expect(
      jobErrorKey(problem(422, { type: "urn:restow:problem:endpoint-hook-not-a-script" })),
    ).toBe("endpoints:errors.hookNotAScript");
    expect(jobErrorKey(problem(403, { type: "urn:restow:problem:recent-sign-in-required" }))).toBe(
      "endpoints:errors.recentSignIn",
    );
  });

  it("falls back to the app's general words", () => {
    expect(jobErrorKey(problem(500, {}))).toBe("common:errors.server");
    expect(jobErrorKey(problem(404, {}))).toBe("common:errors.notFound");
  });
});
