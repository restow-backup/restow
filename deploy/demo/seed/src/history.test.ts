import { describe, expect, it } from "vitest";
import { isDemoRateLimited } from "./api-seed.js";
import { RESTORE_EVERY, restorePlanFor } from "./history.js";

describe("restorePlanFor", () => {
  it("restores every few rounds, never in the first", () => {
    expect(restorePlanFor(0, 2)).toBeNull();
    expect(restorePlanFor(1, 2)).toBeNull();
    expect(restorePlanFor(RESTORE_EVERY, 2)).toBe(0);
    expect(restorePlanFor(RESTORE_EVERY * 2, 2)).toBe(1);
    expect(restorePlanFor(RESTORE_EVERY * 3, 2)).toBe(0);
  });

  it("does nothing without tenants", () => {
    expect(restorePlanFor(RESTORE_EVERY, 0)).toBeNull();
  });
});

describe("isDemoRateLimited", () => {
  it("recognises the demo's rate-limit problem", () => {
    expect(isDemoRateLimited(429, { type: "urn:restow:problem:demo-rate-limited" })).toBe(true);
  });

  it("ignores other refusals", () => {
    expect(
      isDemoRateLimited(429, { type: "urn:restow:problem:demo-restore-budget-exhausted" }),
    ).toBe(false);
    expect(isDemoRateLimited(409, { type: "urn:restow:problem:demo-rate-limited" })).toBe(false);
    expect(isDemoRateLimited(429, null)).toBe(false);
  });
});
