import { describe, expect, it } from "vitest";
import { AGENT_CHECK_IN_MS, earliestOf, jobStateOf, latestOf, nextCheckInOf } from "./dto.js";

const restore = { failed: 0, warning: 0, unverified: 0, noBackup: 0 };
const base = { enabled: true, scopeCount: 3, failed: 0, running: 0, partial: 0, restore };

describe("how a job stands", () => {
  it("is paused before anything else, and empty without objects", () => {
    expect(jobStateOf({ ...base, enabled: false, failed: 2 })).toBe("paused");
    expect(jobStateOf({ ...base, scopeCount: 0 })).toBe("empty");
  });

  it("names the worst thing first", () => {
    expect(jobStateOf({ ...base, failed: 1, running: 1 })).toBe("failing");
    expect(jobStateOf({ ...base, running: 1, partial: 1 })).toBe("running");
    expect(jobStateOf({ ...base, running: 1, queued: 1 })).toBe("running");
    expect(jobStateOf({ ...base, failed: 1, queued: 1 })).toBe("failing");
    expect(jobStateOf({ ...base, queued: 1, partial: 1 })).toBe("queued");
    expect(jobStateOf({ ...base, partial: 1 })).toBe("attention");
    expect(jobStateOf({ ...base, restore: { ...restore, failed: 1 } })).toBe("attention");
    expect(jobStateOf({ ...base, restore: { ...restore, warning: 1 } })).toBe("attention");
    expect(jobStateOf({ ...base, restore: { ...restore, noBackup: 1 } })).toBe("attention");
  });

  it("is ok when nothing is wrong, not a proof of restorability (that is the restore check)", () => {
    expect(jobStateOf(base)).toBe("ok");
    // An unverified backup is not a fault of the job; the restore check column says so.
    expect(jobStateOf({ ...base, restore: { ...restore, unverified: 3 } })).toBe("ok");
  });
});

describe("when the agent asks next", () => {
  it("is its last contact plus the check-in interval, and unknown without one", () => {
    const seen = new Date("2026-10-02T10:00:00.000Z");
    expect(nextCheckInOf(seen)?.getTime()).toBe(seen.getTime() + AGENT_CHECK_IN_MS);
    expect(nextCheckInOf(null)).toBeNull();
  });
});

describe("times", () => {
  it("ignores the missing ones", () => {
    const a = new Date("2026-01-01T00:00:00Z");
    const b = new Date("2026-02-01T00:00:00Z");
    expect(earliestOf([b, null, a])).toEqual(a);
    expect(latestOf([b, null, a])).toEqual(b);
    expect(earliestOf([null])).toBeNull();
    expect(latestOf([])).toBeNull();
  });
});
