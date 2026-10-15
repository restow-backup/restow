import { describe, expect, it } from "vitest";
import { jobRounds } from "./service.js";

describe("jobRounds", () => {
  const at = "2026-10-15T22:00:00.000Z";
  const task = (job: string, guest: string, status: string, created = at) => ({
    job_id: job,
    guest_id: guest,
    status,
    created_at: created,
  });

  it("counts done, failed, running and waiting guests of an open round", () => {
    const rounds = jobRounds(
      [
        task("j", "a", "done"),
        task("j", "b", "failed", "2026-10-15T21:59:30.000Z"),
        task("j", "c", "delivered"),
        task("j", "d", "pending"),
        task("j", "e", "pending"),
      ],
      new Map([["c", "running" as const]]),
    );
    expect(rounds.get("j")).toEqual({
      since: "2026-10-15T21:59:30.000Z",
      total: 5,
      done: 2,
      failed: 1,
      running: 1,
      queued: 2,
    });
  });

  it("drops a round once nothing of it waits or runs", () => {
    expect(jobRounds([task("j", "a", "done"), task("j", "b", "failed")], new Map()).size).toBe(0);
  });
});
