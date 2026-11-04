import { describe, expect, it } from "vitest";

import type { PveRun } from "./api";
import { runStatusKey, runTone } from "./run-status";

type Run = Pick<PveRun, "kind" | "status" | "stats">;
const run = (over: Partial<Run>): Run => ({ kind: "restore", status: "succeeded", ...over });

describe("runTone: green only for proof", () => {
  it("a failed restore or restore check is red, never green", () => {
    for (const kind of ["restore", "restore_test"] as const) {
      expect(runTone(run({ kind, status: "failed" }))).toBe("destructive");
      expect(runStatusKey(run({ kind, status: "failed" }))).toBe("guest.failed");
    }
  });

  it("a cancelled restore or restore check is muted", () => {
    for (const kind of ["restore", "restore_test"] as const) {
      expect(runTone(run({ kind, status: "cancelled" }))).toBe("muted");
    }
  });

  it("a restore or restore check that completed is green; a backup stays neutral", () => {
    expect(runTone(run({ kind: "restore" }))).toBe("success");
    expect(runTone(run({ kind: "restore_test" }))).toBe("success");
    expect(runTone(run({ kind: "backup" }))).toBe("outline");
  });

  it("running work is informational", () => {
    expect(runTone(run({ status: "running" }))).toBe("info");
  });
});
