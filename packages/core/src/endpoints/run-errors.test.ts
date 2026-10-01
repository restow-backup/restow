import { describe, expect, it } from "vitest";
import { isInterruptedOnly, resticExitCodeOf } from "./run-errors.js";

describe("run error codes", () => {
  it("knows a run that was only interrupted by an agent restart", () => {
    expect(isInterruptedOnly([{ code: "interrupted" }])).toBe(true);
    expect(isInterruptedOnly([{ code: "interrupted" }, { code: "interrupted" }])).toBe(true);
    expect(isInterruptedOnly([])).toBe(false);
    expect(isInterruptedOnly([{ code: "interrupted" }, { code: "read_error" }])).toBe(false);
    expect(isInterruptedOnly([{}])).toBe(false);
    expect(isInterruptedOnly([{ code: null }])).toBe(false);
  });

  it("reads restic's exit code from its error code", () => {
    expect(resticExitCodeOf("restic_exit_1")).toBe(1);
    expect(resticExitCodeOf("restic_exit_130")).toBe(130);
    expect(resticExitCodeOf("read_error")).toBeNull();
    expect(resticExitCodeOf(undefined)).toBeNull();
  });
});
