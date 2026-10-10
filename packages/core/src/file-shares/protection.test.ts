import { describe, expect, it } from "vitest";
import {
  shareJobOf,
  shareProtected,
  shareProtectedSince,
  shareStaleBackupHours,
} from "./protection.js";

const now = new Date("2026-10-10T12:00:00Z");
const jobs = [
  {
    id: "j1",
    kind: "share",
    enabled: true,
    schedule: { kind: "daily" as const, timeOfDay: "02:00", timeZone: "UTC" },
    createdAt: new Date("2026-10-05"),
  },
  { id: "j2", kind: "share", enabled: false, schedule: null, createdAt: new Date("2026-10-01") },
  { id: "j3", kind: "copy", enabled: true, schedule: null, createdAt: new Date("2026-10-01") },
];
const members = [
  { jobId: "j1", fileShareId: "s1" },
  { jobId: "j2", fileShareId: "s2" },
  {
    jobId: "j1",
    fileShareId: "s4",
    overrides: {
      schedule: { kind: "interval" as const, intervalMinutes: 7 * 24 * 60, timeZone: "UTC" },
    },
  },
];

describe("file share protection (section 13)", () => {
  it("is protected only in an enabled share job and while not retired", () => {
    expect(shareProtected({ id: "s1", retiredAt: null }, jobs, members)).toBe(true);
    expect(shareProtected({ id: "s1", retiredAt: now }, jobs, members)).toBe(false);
    expect(shareProtected({ id: "s2", retiredAt: null }, jobs, members)).toBe(false);
    expect(shareProtected({ id: "s3", retiredAt: null }, jobs, members)).toBe(false);
    expect(shareJobOf({ id: "s1" }, jobs, members)?.id).toBe("j1");
  });

  it("is overdue after twice the planned gap, by the member's own schedule first", () => {
    expect(shareStaleBackupHours({ id: "s1" }, jobs, members, now)).toBe(48);
    expect(shareStaleBackupHours({ id: "s4" }, jobs, members, now)).toBe(14 * 24);
    expect(
      shareProtectedSince(
        { createdAt: new Date("2026-10-01"), lastSuccessAt: null },
        { createdAt: new Date("2026-10-05") },
      ),
    ).toEqual(new Date("2026-10-05"));
  });
});
