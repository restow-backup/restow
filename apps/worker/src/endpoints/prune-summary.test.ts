import { ResticError } from "@restow/core";
import { describe, expect, it } from "vitest";
import { pruneFailureSummary, pruneSummary, targetFull } from "./prune-summary.js";

describe("what a retention report says about its prune", () => {
  it("records a delete-only prune and keeps a deferred repack due", () => {
    expect(pruneSummary(null)).toEqual({});
    expect(
      pruneSummary({ mode: "full", reason: null, repackDeferred: false, freeBytesBefore: null }),
    ).toEqual({ pruneMode: "full" });
    expect(
      pruneSummary({
        mode: "delete_only",
        reason: "low_space",
        repackDeferred: true,
        freeBytesBefore: 1024,
      }),
    ).toEqual({ pruneMode: "delete_only", pruneReason: "low_space", prunePending: true });
  });

  it("says target full only for restic giving up for lack of space [RETAIN-015]", () => {
    const full = new ResticError("restic prune failed", 1, "storage_full", "");
    const other = new ResticError("restic prune failed", 1, "other", "");
    expect(targetFull(full)).toBe(true);
    expect(pruneFailureSummary(full)).toEqual({ targetFull: true, prunePending: true });
    expect(targetFull(other)).toBe(false);
    expect(pruneFailureSummary(other)).toEqual({});
    expect(pruneFailureSummary(new Error("no space"))).toEqual({});
  });
});
