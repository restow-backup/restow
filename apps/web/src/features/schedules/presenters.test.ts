import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import type { ScheduleItem } from "./api.js";
import "./i18n.js";
import {
  JOB_STATUS_TONE,
  type ScheduleDraft,
  checkDraft,
  coverageOf,
  describeCadence,
  describeScope,
  draftFromSchedule,
  fieldProblem,
  formatClock,
  inputFromDraft,
  intervalRuns,
  lastActivityAt,
  mondayFirst,
  needsDisableConfirmation,
  newDraft,
  patchFromDraft,
  timeZoneOptions,
} from "./presenters.js";

function item(overrides: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: "schedule-1",
    kind: "backup",
    protectedObject: null,
    intervalMinutes: 480,
    cron: null,
    timezone: "Europe/Berlin",
    enabled: true,
    nextRunAt: "2026-03-01T18:00:00.000Z",
    lastRunAt: "2026-03-01T10:00:00.000Z",
    lastJob: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

const en = () => i18n.getFixedT("en", "schedules");
const de = () => i18n.getFixedT("de", "schedules");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("describeCadence", () => {
  it("puts intervals and presets into words in English and German", () => {
    expect(describeCadence({ intervalMinutes: 480, cron: null }, en(), "en")).toBe("Every 8 hours");
    expect(describeCadence({ intervalMinutes: 60, cron: null }, en(), "en")).toBe("Every hour");
    expect(describeCadence({ intervalMinutes: 90, cron: null }, en(), "en")).toBe(
      "Every 90 minutes",
    );
    expect(describeCadence({ intervalMinutes: 480, cron: null }, de(), "de")).toBe(
      "Alle 8 Stunden",
    );
    expect(describeCadence({ intervalMinutes: null, cron: "30 4 * * *" }, de(), "de")).toBe(
      "Täglich um 04:30",
    );
    expect(describeCadence({ intervalMinutes: null, cron: "0 3 * * 0" }, de(), "de")).toBe(
      "Jeden Sonntag um 03:00",
    );
    expect(describeCadence({ intervalMinutes: null, cron: "0 3 * * 0,3" }, en(), "en")).toMatch(
      /^Every Wednesday and Sunday at /,
    );
    expect(describeCadence({ intervalMinutes: null, cron: "0 7 * * 1-5" }, de(), "de")).toBe(
      "Montag bis Freitag um 07:00",
    );
    expect(describeCadence({ intervalMinutes: null, cron: "0 5 1 * *" }, de(), "de")).toBe(
      "Monatlich am 1. um 05:00",
    );
  });

  it("shows custom expressions as written", () => {
    expect(describeCadence({ intervalMinutes: null, cron: "*/30 8-18 * * 1-5" }, en(), "en")).toBe(
      "Custom: */30 8-18 * * 1-5",
    );
  });

  it("formats wall-clock times in the UI language", () => {
    expect(formatClock(4, 30, "de")).toBe("04:30");
    expect(formatClock(16, 5, "en")).toMatch(/04:05\sPM/);
    expect(mondayFirst([0, 6, 1])).toEqual([1, 6, 0]);
  });
});

describe("describeScope", () => {
  it("names the object, all objects or the whole tenant", () => {
    const t = en();
    expect(
      describeScope(item({ protectedObject: { id: "o", name: "Anna Berg", kind: "mailbox" } }), t),
    ).toBe("Anna Berg");
    expect(describeScope(item(), t)).toBe("All protected objects");
    expect(describeScope(item({ kind: "scrub" }), t)).toBe("Whole tenant");
  });

  it("says plainly that another person's object is not named", () => {
    const withheld = item({ protectedObject: { id: null, name: null, kind: "onedrive" } });
    expect(describeScope(withheld, en())).toBe("One OneDrive (not yours)");
    // Still narrowed to one object: it does not count as covering everything.
    expect(coverageOf([withheld], "backup").state).toBe("missing");
  });
});

describe("coverageOf", () => {
  it("is active only with a tenant-wide schedule that is on", () => {
    expect(coverageOf([item()], "backup")).toEqual({ state: "active", paused: null });
    expect(coverageOf([], "backup")).toEqual({ state: "missing", paused: null });
    const paused = item({ enabled: false });
    expect(coverageOf([paused], "backup")).toEqual({ state: "paused", paused });
    // A schedule for one object does not protect the others.
    expect(
      coverageOf([item({ protectedObject: { id: "o", name: "Anna", kind: "mailbox" } })], "backup")
        .state,
    ).toBe("missing");
    expect(coverageOf([item()], "verify").state).toBe("missing");
  });

  it("asks before switching off backups or verification only", () => {
    expect(needsDisableConfirmation(item())).toBe(true);
    expect(needsDisableConfirmation(item({ kind: "verify" }))).toBe(true);
    expect(needsDisableConfirmation(item({ kind: "scrub" }))).toBe(false);
    expect(needsDisableConfirmation(item({ enabled: false }))).toBe(false);
  });
});

describe("schedule draft", () => {
  it("starts a new schedule as a backup every 8 hours of every object", () => {
    const draft = newDraft("Europe/Vienna");
    const check = checkDraft(draft);
    expect(check).toEqual({ ok: true, cadence: { intervalMinutes: 480, cron: null } });
    if (!check.ok) return;
    expect(inputFromDraft(draft, check.cadence)).toEqual({
      kind: "backup",
      protectedObjectId: null,
      intervalMinutes: 480,
      cron: null,
      timezone: "Europe/Vienna",
      enabled: true,
    });
  });

  it("reads an existing schedule into the form and sends only what changed", () => {
    const weekly = item({ kind: "verify", intervalMinutes: null, cron: "0 3 * * 0" });
    const draft = draftFromSchedule(weekly);
    expect(draft).toMatchObject({ presetType: "weekly", days: [0], time: "03:00" });
    const unchanged = checkDraft(draft);
    expect(unchanged.ok && patchFromDraft(weekly, draft, unchanged.cadence)).toEqual({});

    const moved: ScheduleDraft = { ...draft, days: [0, 3], time: "02:15", timezone: "UTC" };
    const check = checkDraft(moved);
    expect(check.ok && patchFromDraft(weekly, moved, check.cadence)).toEqual({
      intervalMinutes: null,
      cron: "15 2 * * 0,3",
      timezone: "UTC",
    });

    const custom = draftFromSchedule(item({ intervalMinutes: null, cron: "*/20 * * * *" }));
    expect(custom).toMatchObject({ presetType: "custom", cron: "*/20 * * * *" });
  });

  it("narrows only backup and verify schedules to an object", () => {
    const draft = {
      ...newDraft("UTC"),
      scope: "object" as const,
      object: { id: "object-1", name: "Anna" },
    };
    const check = checkDraft(draft);
    expect(check.ok && inputFromDraft(draft, check.cadence).protectedObjectId).toBe("object-1");
    const scrub = { ...draft, kind: "scrub" as const };
    expect(check.ok && inputFromDraft(scrub, check.cadence).protectedObjectId).toBeNull();
    expect(checkDraft({ ...draft, object: null })).toEqual({
      ok: false,
      field: "object",
      reason: "required",
    });
  });

  it("names the field to correct", () => {
    const base = newDraft("UTC");
    expect(checkDraft({ ...base, hours: "" })).toMatchObject({
      field: "hours",
      reason: "required",
    });
    expect(checkDraft({ ...base, hours: "745" })).toMatchObject({
      field: "hours",
      reason: "range",
    });
    expect(checkDraft({ ...base, presetType: "every_minutes", minutes: "5" })).toMatchObject({
      field: "minutes",
      reason: "range",
    });
    expect(checkDraft({ ...base, presetType: "daily", time: "" })).toMatchObject({ field: "time" });
    expect(checkDraft({ ...base, presetType: "weekly", days: [] })).toMatchObject({
      field: "days",
    });
    expect(checkDraft({ ...base, presetType: "monthly", dayOfMonth: "31" })).toMatchObject({
      field: "dayOfMonth",
      reason: "range",
    });
    expect(checkDraft({ ...base, presetType: "custom", cron: "  " })).toMatchObject({
      field: "cron",
    });
  });
});

describe("fieldProblem", () => {
  it("maps a 422 problem that names a field to a translated reason", () => {
    const refused = new ApiError(
      422,
      { type: "t", title: "Invalid schedule", status: 422, field: "cron", code: "cron_invalid" },
      "x",
    );
    expect(fieldProblem(refused)).toEqual({ field: "cron", key: "problems.cron_invalid" });
    const unknown = new ApiError(
      422,
      { type: "t", title: "x", status: 422, field: "timezone", code: "new_code" },
      "x",
    );
    expect(fieldProblem(unknown)).toEqual({ field: "timezone", key: "problems.generic" });
    expect(fieldProblem(new ApiError(500, null, "x"))).toBeNull();
    expect(fieldProblem(new Error("x"))).toBeNull();
  });
});

describe("intervalRuns and time zones", () => {
  it("counts interval runs from the last run, or starts now", () => {
    const now = Date.parse("2026-03-01T12:00:00.000Z");
    expect(
      intervalRuns(480, "2026-03-01T10:00:00.000Z", now, 2).map((run) => run.toISOString()),
    ).toEqual(["2026-03-01T18:00:00.000Z", "2026-03-02T02:00:00.000Z"]);
    expect(intervalRuns(60, null, now, 1)[0]?.toISOString()).toBe("2026-03-01T12:00:00.000Z");
    // Overdue: now, not in the past.
    expect(intervalRuns(60, "2026-03-01T08:00:00.000Z", now, 1)[0]?.toISOString()).toBe(
      "2026-03-01T12:00:00.000Z",
    );
  });

  it("lists the given zones first, once, and always offers UTC", () => {
    const zones = timeZoneOptions(["Europe/Berlin", "Europe/Berlin", ""]);
    expect(zones[0]).toBe("Europe/Berlin");
    expect(zones.filter((zone) => zone === "Europe/Berlin")).toHaveLength(1);
    expect(zones).toContain("UTC");
  });
});

describe("lastActivityAt", () => {
  const job = (finishedAt: string | null) => ({
    id: "j",
    status: "completed" as const,
    finishedAt,
  });
  it("shows a check run after a backup even when the schedule itself never fired", () => {
    expect(lastActivityAt({ lastRunAt: null, lastJob: job("2026-09-29T10:00:00Z") })).toBe(
      "2026-09-29T10:00:00Z",
    );
  });
  it("takes the later of the schedule's own run and its newest job", () => {
    expect(
      lastActivityAt({ lastRunAt: "2026-09-28T10:00:00Z", lastJob: job("2026-09-29T10:00:00Z") }),
    ).toBe("2026-09-29T10:00:00Z");
    expect(
      lastActivityAt({ lastRunAt: "2026-09-30T10:00:00Z", lastJob: job("2026-09-29T10:00:00Z") }),
    ).toBe("2026-09-30T10:00:00Z");
    expect(lastActivityAt({ lastRunAt: null, lastJob: null })).toBeNull();
  });
});

describe("JOB_STATUS_TONE", () => {
  it("shows a run that completed as neutral: green is for a passed restore check", () => {
    expect(JOB_STATUS_TONE.completed).toBe("neutral");
    expect(Object.values(JOB_STATUS_TONE)).not.toContain("success");
    expect(JOB_STATUS_TONE.failed).toBe("destructive");
    expect(JOB_STATUS_TONE.active).toBe("info");
  });
});
