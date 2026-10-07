import { describe, expect, it } from "vitest";

import { coverageOf, mailCoverageOf, runsOnSchedule } from "./coverage.js";

const DAILY = { kind: "cron" as const, cron: "0 22 * * *", timeZone: "Europe/Berlin" };

function job(
  id: string,
  options: { enabled?: boolean; schedule?: typeof DAILY | null; scopeMode?: "all" | "selected" },
) {
  return {
    id,
    name: `Job ${id}`,
    kind: "mail" as const,
    enabled: options.enabled ?? true,
    schedule: options.schedule === undefined ? DAILY : options.schedule,
    scopeMode: options.scopeMode ?? "selected",
  };
}

const objects = [
  { id: "a", eligible: true },
  { id: "b", eligible: true },
  { id: "c", eligible: true },
  { id: "x", eligible: false },
];

describe("which job backs up a mail object", () => {
  it("counts only a job that is on and has a schedule as backing it up", () => {
    expect(runsOnSchedule({ enabled: true, schedule: DAILY }, undefined)).toBe(true);
    expect(runsOnSchedule({ enabled: false, schedule: DAILY }, undefined)).toBe(false);
    expect(runsOnSchedule({ enabled: true, schedule: null }, undefined)).toBe(false);
    // A member with its own schedule runs even in a job without one.
    expect(
      runsOnSchedule({ enabled: true, schedule: null }, { overrides: { schedule: DAILY } }),
    ).toBe(true);
  });

  it("tells objects in a running job, in a paused or manual job and in none apart", () => {
    const jobs = [
      job("run", {}),
      job("paused", { enabled: false }),
      job("manual", { schedule: null }),
    ];
    const members = [
      { jobId: "run", protectedObjectId: "a", overrides: {} },
      { jobId: "paused", protectedObjectId: "b", overrides: {} },
      { jobId: "manual", protectedObjectId: "x", overrides: {} },
    ];
    const links = mailCoverageOf(jobs, members, objects);
    expect(links.get("a")).toEqual({ id: "run", name: "Job run", scheduled: true });
    expect(links.get("b")).toMatchObject({ id: "paused", scheduled: false });
    expect(coverageOf(objects[0], links)).toBe("scheduled");
    expect(coverageOf(objects[1], links)).toBe("unscheduled");
    expect(coverageOf(objects[2], links)).toBe("none");
    // An object that may not be backed up at all has no coverage to speak of.
    expect(coverageOf(objects[3], links)).toBeNull();
  });

  it("lets an 'all' job cover what no other job has", () => {
    const jobs = [job("all", { scopeMode: "all", schedule: null }), job("run", {})];
    const members = [{ jobId: "run", protectedObjectId: "a", overrides: {} }];
    const links = mailCoverageOf(jobs, members, objects);
    expect(links.get("a")?.id).toBe("run");
    expect(links.get("b")).toMatchObject({ id: "all", scheduled: false });
    expect(links.has("x")).toBe(false);
  });

  it("ignores machine jobs", () => {
    const machines = { ...job("m", { scopeMode: "all" }), kind: "endpoint" as const };
    expect(mailCoverageOf([machines], [], objects).size).toBe(0);
  });
});
