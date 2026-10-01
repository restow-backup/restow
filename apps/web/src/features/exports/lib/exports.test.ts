import { describe, expect, it } from "vitest";

import type { MailExport } from "@/features/exports/api";
import {
  downloadState,
  expiryMessage,
  expiryOf,
  failureRows,
  isCancellable,
  isLive,
  needsClock,
  phaseKey,
  skippedEntries,
  statusKey,
  statusTone,
} from "@/features/exports/lib/exports";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function item(patch: Partial<MailExport> = {}): MailExport {
  return {
    id: "e1",
    jobId: "j1",
    origin: "snapshot",
    format: "eml_zip",
    status: "completed",
    object: null,
    snapshotId: "s1",
    selection: { items: 3, folders: 1 },
    fileName: "export.zip",
    fileSize: 1024,
    sha256: "a".repeat(64),
    createdAt: at(-HOUR),
    completedAt: at(-30 * MINUTE),
    expiresAt: at(23 * HOUR),
    available: true,
    progress: null,
    phase: null,
    actor: { userId: "u1", name: "Lena", email: "lena@example.test" },
    impersonated: false,
    ...patch,
  };
}

describe("expiryOf", () => {
  it("counts down in hours and minutes inside the 24 hour window", () => {
    expect(expiryOf(at(23 * HOUR + 14 * MINUTE + 30_000), NOW)).toEqual({
      kind: "hours",
      hours: 23,
      minutes: 14,
    });
  });

  it("switches to minutes below one hour and to 'soon' below one minute", () => {
    expect(expiryOf(at(14 * MINUTE + 59_000), NOW)).toEqual({ kind: "minutes", minutes: 14 });
    expect(expiryOf(at(30_000), NOW)).toEqual({ kind: "soon" });
  });

  it("uses days once the window is longer than two days", () => {
    expect(expiryOf(at(3 * DAY + 5 * HOUR), NOW)).toEqual({ kind: "days", days: 3, hours: 5 });
  });

  it("is expired at and after the expiry time", () => {
    expect(expiryOf(at(0), NOW)).toEqual({ kind: "expired" });
    expect(expiryOf(at(-HOUR), NOW)).toEqual({ kind: "expired" });
  });

  it("has no expiry for a missing or unparsable time", () => {
    expect(expiryOf(null, NOW)).toEqual({ kind: "none" });
    expect(expiryOf("not a date", NOW)).toEqual({ kind: "none" });
  });
});

describe("expiryMessage", () => {
  it("maps each unit to its own sentence or short form", () => {
    expect(expiryMessage({ kind: "hours", hours: 2, minutes: 5 })).toEqual({
      key: "expiry.hours",
      values: { hours: 2, minutes: 5 },
    });
    expect(expiryMessage({ kind: "minutes", minutes: 9 }, "short")).toEqual({
      key: "expiryShort.minutes",
      values: { minutes: 9 },
    });
    expect(expiryMessage({ kind: "soon" })?.key).toBe("expiry.soon");
    expect(expiryMessage({ kind: "expired" })).toBeNull();
    expect(expiryMessage({ kind: "none" })).toBeNull();
  });
});

describe("downloadState", () => {
  it("is pending while the export runs", () => {
    expect(downloadState(item({ status: "queued", available: false }), NOW)).toBe("pending");
    expect(downloadState(item({ status: "active", available: false }), NOW)).toBe("pending");
  });

  it("is ready for a completed export whose link still works", () => {
    expect(downloadState(item(), NOW)).toBe("ready");
  });

  it("is expired when the server says the file is gone", () => {
    expect(downloadState(item({ available: false }), NOW)).toBe("expired");
  });

  it("is expired once the local clock passes the expiry, even before the next refresh", () => {
    expect(downloadState(item({ expiresAt: at(-1) }), NOW)).toBe("expired");
  });

  it("has no file for failed or cancelled exports", () => {
    expect(downloadState(item({ status: "failed", available: false }), NOW)).toBe("none");
    expect(downloadState(item({ status: "cancelled", available: false }), NOW)).toBe("none");
  });
});

describe("needsClock", () => {
  it("only runs while a finished, available export has an expiry to count down", () => {
    expect(needsClock(item())).toBe(true);
    expect(needsClock(item({ available: false }))).toBe(false);
    expect(needsClock(item({ status: "active" }))).toBe(false);
    expect(needsClock(item({ expiresAt: null }))).toBe(false);
  });
});

describe("status", () => {
  it("knows live and cancellable states", () => {
    expect(isLive({ status: "queued" })).toBe(true);
    expect(isLive({ status: "active" })).toBe(true);
    expect(isLive({ status: "completed" })).toBe(false);
    expect(isCancellable({ status: "active" })).toBe(true);
    expect(isCancellable({ status: "failed" })).toBe(false);
  });

  it("shows a completed export with failed mails as a warning, never as plain success", () => {
    expect(statusTone(item())).toBe("outline");
    expect(statusKey(item())).toBe("status.completed");
    const withProblems = item({
      progress: { total: 10, done: 8, failed: 2, bytes: 1, etaSeconds: null },
    });
    expect(statusTone(withProblems)).toBe("warning");
    expect(statusKey(withProblems)).toBe("status.completedWithIssues");
    expect(statusTone({ ...item(), report: { failed: 1 } })).toBe("warning");
  });

  it("maps the other statuses", () => {
    expect(statusTone(item({ status: "failed" }))).toBe("destructive");
    expect(statusTone(item({ status: "cancelled" }))).toBe("secondary");
    expect(statusTone(item({ status: "queued" }))).toBe("muted");
    expect(statusKey(item({ status: "active" }))).toBe("status.active");
  });
});

describe("phaseKey", () => {
  it("translates the phases it knows and ignores anything else", () => {
    expect(phaseKey("writing")).toBe("phase.writing");
    expect(phaseKey("something-new")).toBeNull();
    expect(phaseKey(null)).toBeNull();
  });
});

describe("skippedEntries", () => {
  it("lists only the counters above zero, in a fixed order", () => {
    expect(skippedEntries({ calendar: 12, contacts: 0, other: 3 })).toEqual([
      { kind: "calendar", count: 12 },
      { kind: "other", count: 3 },
    ]);
    expect(skippedEntries({ calendar: 0, contacts: 0, other: 0 })).toEqual([]);
    expect(skippedEntries(null)).toEqual([]);
  });
});

describe("failureRows", () => {
  it("prefers the final report and falls back to the live failures", () => {
    expect(
      failureRows({
        report: { items: [{ ref: "Inbox/1.eml", reason: "chunk missing" }] },
        failures: [{ itemRef: "live", reason: "x" }],
      }),
    ).toEqual([{ ref: "Inbox/1.eml", reason: "chunk missing" }]);
    expect(failureRows({ report: null, failures: [{ itemRef: "live", reason: "x" }] })).toEqual([
      { ref: "live", reason: "x" },
    ]);
    expect(failureRows({ report: { items: [] }, failures: [] })).toEqual([]);
  });
});
