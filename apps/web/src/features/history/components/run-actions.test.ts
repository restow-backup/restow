import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import { agentRun, finished, run } from "../fixtures";

import { isNoJobProblem, retryable, runNowOf } from "./run-actions";

describe("what Run now does", () => {
  it("backs up the run's own object again through its job, not the whole job", () => {
    const mail = run();
    expect(runNowOf(mail)).toEqual({
      kind: "job",
      job: { id: mail.job?.id, name: "Mail backup" },
      target: { id: mail.subject?.id, name: mail.subject?.name },
    });
    const machine = agentRun();
    expect(runNowOf(machine)).toMatchObject({ kind: "job", target: { id: machine.subject?.id } });
  });

  it("runs the whole job only for a run without a subject", () => {
    expect(runNowOf(run({ subject: null }))).toMatchObject({ kind: "job", target: null });
  });

  it("backs up the object of a backup that belongs to no job", () => {
    const mail = run({ job: null });
    expect(runNowOf(mail)).toEqual({ kind: "mail", objectId: mail.subject?.id });
    const machine = agentRun({ job: null });
    expect(runNowOf(machine)).toEqual({ kind: "machine", endpointId: machine.subject?.id });
  });

  it("has nothing to run for what is not a backup of an object", () => {
    expect(runNowOf(run({ job: null, kind: "restore" }))).toBeNull();
    expect(runNowOf(run({ job: null, kind: "maintenance", subject: null }))).toBeNull();
    expect(runNowOf(run({ job: null, subject: null }))).toBeNull();
  });
});

describe("Run now for the runs of file shares", () => {
  const subject = { kind: "file_share" as const, id: "share-1", name: "Office", detail: null };
  const job = { id: "job-1", name: "Shares" };

  it("backs up the share through its job, and runs a copy job as a whole", () => {
    expect(runNowOf({ ...run(), source: "file_share", subject, job, type: "backup" })).toEqual({
      kind: "job",
      job,
      target: { id: "share-1", name: "Office" },
    });
    expect(
      runNowOf({ ...run(), source: "file_share", subject, job, kind: "restore", type: "copy" }),
    ).toEqual({ kind: "job", job, target: null });
  });

  it("offers nothing for a share backup without a job (its page has Back up now)", () => {
    expect(runNowOf({ ...run(), source: "file_share", subject, job: null })).toBeNull();
  });

  it("never retries a share run from History", () => {
    expect(retryable({ source: "file_share", state: "failed", type: "backup" })).toBe(false);
  });
});

describe("what can be retried", () => {
  it("is a failed or cancelled mail backup or restore check, nothing else", () => {
    expect(retryable(finished("failed"))).toBe(true);
    expect(retryable(finished("cancelled"))).toBe(true);
    expect(retryable(finished("failed", { type: "verify" }))).toBe(true);
    expect(retryable(finished("failed", { type: "restore" }))).toBe(false);
    expect(retryable(finished("succeeded"))).toBe(false);
    expect(retryable(run())).toBe(false);
    // An agent decides when it runs again.
    expect(retryable(agentRun({ state: "failed" }))).toBe(false);
  });
});

describe("a machine backup refused for want of a job", () => {
  it("is recognised by its problem type", () => {
    const noJob = new ApiError(
      409,
      { type: "urn:restow:problem:endpoint-no-job", title: "No job", status: 409 },
      "Conflict",
    );
    expect(isNoJobProblem(noJob)).toBe(true);
    expect(isNoJobProblem(new ApiError(409, null, "Conflict"))).toBe(false);
    expect(isNoJobProblem(new Error("x"))).toBe(false);
  });
});
