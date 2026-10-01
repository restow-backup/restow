import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_DAILY_RESTORE_BYTES,
  DEMO_DAILY_RESTORE_ITEMS,
  DEMO_MAX_RESTORE_BYTES,
  assertDemoRestoreBudgetOk,
  assertDemoRestoreSizeOk,
  recordDemoRestoreUsage,
  resetDemoRestoreBudgetForTests,
} from "./demo-limits.js";

describe("assertDemoRestoreSizeOk", () => {
  it("accepts a restore at or below the per-request cap", () => {
    expect(() => assertDemoRestoreSizeOk(0)).not.toThrow();
    expect(() => assertDemoRestoreSizeOk(DEMO_MAX_RESTORE_BYTES)).not.toThrow();
  });

  it("refuses a restore over the per-request cap", () => {
    expect(() => assertDemoRestoreSizeOk(DEMO_MAX_RESTORE_BYTES + 1)).toThrow(/too large|demo/i);
  });
});

describe("daily restore budget", () => {
  const FIXED_NOW = new Date("2026-01-15T10:00:00.000Z").getTime();

  beforeEach(() => {
    // Fake the clock first: resetDemoRestoreBudgetForTests() itself reads
    // Date.now() to seed the rollover boundary.
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    resetDemoRestoreBudgetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows usage within the daily caps", () => {
    expect(() => assertDemoRestoreBudgetOk(1000, 5, FIXED_NOW)).not.toThrow();
  });

  it("accumulates recorded usage and refuses once the byte cap is exceeded", () => {
    recordDemoRestoreUsage(DEMO_DAILY_RESTORE_BYTES - 100, 1, FIXED_NOW);
    expect(() => assertDemoRestoreBudgetOk(50, 1, FIXED_NOW)).not.toThrow();
    expect(() => assertDemoRestoreBudgetOk(200, 1, FIXED_NOW)).toThrow(/budget/i);
  });

  it("refuses once the daily item cap is exceeded", () => {
    recordDemoRestoreUsage(0, DEMO_DAILY_RESTORE_ITEMS, FIXED_NOW);
    expect(() => assertDemoRestoreBudgetOk(0, 1, FIXED_NOW)).toThrow(/budget/i);
  });

  it("rolls over at the next UTC day boundary", () => {
    recordDemoRestoreUsage(DEMO_DAILY_RESTORE_BYTES, DEMO_DAILY_RESTORE_ITEMS, FIXED_NOW);
    expect(() => assertDemoRestoreBudgetOk(1, 1, FIXED_NOW)).toThrow(/budget/i);

    const nextDay = Date.UTC(2026, 0, 16, 0, 0, 1);
    expect(() => assertDemoRestoreBudgetOk(1000, 5, nextDay)).not.toThrow();
  });
});
