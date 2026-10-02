import { describe, expect, it } from "vitest";

import { agentRun, finished, run } from "../fixtures";
import { retryable, runNowOf } from "./run-actions";

describe("what Run now does", () => {
  it("runs the job a run belongs to", () => {
    expect(runNowOf(run())).toEqual({
      kind: "job",
      job: { id: run().job?.id, name: "Mail backup" },
    });
    expect(runNowOf(agentRun())?.kind).toBe("job");
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
