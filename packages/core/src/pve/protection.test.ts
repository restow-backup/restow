import { describe, expect, it } from "vitest";
import { pveNextRunAt } from "./model.js";
import {
  pveGuestBackable,
  pveGuestIsRestowServer,
  pveJobOfGuest,
  pveRestorePointReadiness,
  pveSelfBackupBlocked,
  pveStaleBackupHours,
} from "./protection.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const guest = (extra: Partial<Parameters<typeof pveJobOfGuest>[0]> = {}) => ({
  jobId: null,
  kind: "vm" as const,
  template: false,
  present: true,
  ...extra,
});

describe("when a guest is protected", () => {
  const own = { id: "own", enabled: true, scopeAll: false };
  const paused = { id: "paused", enabled: false, scopeAll: false };
  const all = { id: "all", enabled: true, scopeAll: true };

  it("is in its own enabled job, or in the job for all guests while it has none", () => {
    expect(pveJobOfGuest(guest({ jobId: "own" }), [own, all])).toBe(own);
    expect(pveJobOfGuest(guest(), [own, all])).toBe(all);
    expect(pveJobOfGuest(guest(), [own])).toBeNull();
  });

  it("is not protected by a paused job, and the job for all guests does not step in", () => {
    expect(pveJobOfGuest(guest({ jobId: "paused" }), [paused, all])).toBeNull();
    expect(pveJobOfGuest(guest(), [{ ...all, enabled: false }])).toBeNull();
    // A job that is gone protects nothing.
    expect(pveJobOfGuest(guest({ jobId: "deleted" }), [all])).toBeNull();
  });

  it("never protects a VM template or a guest its node no longer reports", () => {
    expect(pveJobOfGuest(guest({ jobId: "own", template: true }), [own])).toBeNull();
    expect(pveJobOfGuest(guest({ jobId: "own", present: false }), [own])).toBeNull();
    // A container template is an ordinary container for the backup.
    expect(pveJobOfGuest(guest({ jobId: "own", kind: "ct", template: true }), [own])).toBe(own);
    expect(pveGuestBackable(guest({ template: true }))).toBe(false);
  });
});

describe("the rating of a restore point", () => {
  it("is unverified until a check read it back, red on any mismatch or error", () => {
    expect(pveRestorePointReadiness(null)).toBeNull();
    const checkedAt = NOW.toISOString();
    expect(pveRestorePointReadiness({ checkedAt, mismatched: 0, errors: [] })).toBe("green");
    expect(pveRestorePointReadiness({ checkedAt, mismatched: 1, errors: ["x"] })).toBe("red");
    expect(pveRestorePointReadiness({ checkedAt, mismatched: 0, errors: ["unreadable"] })).toBe(
      "red",
    );
  });

  it("is yellow, never red or green, once a check could not run for a locked repository", () => {
    const at = NOW.toISOString();
    const notChecked = { since: at, gaveUpAt: at };
    expect(pveRestorePointReadiness({ mismatched: 0, errors: [], notChecked })).toBe("yellow");
    // Still trying: the previous result stands (here none: unverified).
    expect(
      pveRestorePointReadiness({ mismatched: 0, errors: [], notChecked: { gaveUpAt: null } }),
    ).toBeNull();
    expect(
      pveRestorePointReadiness({ checkedAt: at, mismatched: 0, errors: [], notChecked: {} }),
    ).toBe("green");
  });
});

describe("when a guest is overdue", () => {
  it("follows the most relaxed enabled schedule, two days without any", () => {
    expect(pveStaleBackupHours([], NOW)).toBe(48);
    expect(pveStaleBackupHours([null], NOW)).toBe(48);
    expect(pveStaleBackupHours([{ kind: "daily", timeOfDay: "22:00", timeZone: "UTC" }], NOW)).toBe(
      48,
    );
    expect(
      pveStaleBackupHours(
        [
          { kind: "interval", intervalMinutes: 60, timeZone: "UTC" },
          { kind: "interval", intervalMinutes: 3 * 24 * 60, timeZone: "UTC" },
        ],
        NOW,
      ),
    ).toBe(144);
    // At least a day, however often a job runs.
    expect(
      pveStaleBackupHours([{ kind: "interval", intervalMinutes: 60, timeZone: "UTC" }], NOW),
    ).toBe(24);
  });
});

describe("a PVE job's cron schedule (0.4.2)", () => {
  it("plans weekdays and months like a mail job", () => {
    // Monday to Friday at 02:30 in Berlin; NOW is a Wednesday.
    const next = pveNextRunAt(
      { kind: "cron", cron: "30 2 * * 1-5", timeZone: "Europe/Berlin" },
      NOW,
      null,
    );
    expect(next.toISOString()).toBe("2026-10-08T00:30:00.000Z");
    const monthly = pveNextRunAt({ kind: "cron", cron: "0 5 1 * *", timeZone: "UTC" }, NOW, null);
    expect(monthly.toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(() =>
      pveNextRunAt({ kind: "cron", cron: "nonsense", timeZone: "UTC" }, NOW, null),
    ).toThrow();
  });

  it("counts a weekly cron schedule as a week between backups for the overdue rule", () => {
    expect(pveStaleBackupHours([{ kind: "cron", cron: "0 3 * * 0", timeZone: "UTC" }], NOW)).toBe(
      14 * 24,
    );
  });
});

describe("the Restow server's own VM", () => {
  it("is found or flagged, and blocked until confirmed", () => {
    expect(pveGuestIsRestowServer({})).toBe(false);
    expect(pveGuestIsRestowServer({ restowServerDetected: true })).toBe(true);
    expect(pveGuestIsRestowServer({ restowServerFlagged: true })).toBe(true);
    expect(pveSelfBackupBlocked({ restowServerDetected: true })).toBe(true);
    expect(
      pveSelfBackupBlocked({ restowServerFlagged: true, selfBackupConfirmedAt: new Date() }),
    ).toBe(false);
    expect(pveSelfBackupBlocked({ selfBackupConfirmedAt: null })).toBe(false);
  });
});
