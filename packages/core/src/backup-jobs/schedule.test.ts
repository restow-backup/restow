import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_BACKUP_HOURS,
  MIN_STALE_BACKUP_HOURS,
  endpointScheduleOf,
  jobScheduleFromCadence,
  jobScheduleFromEndpoint,
  longestPlannedGapMinutes,
  mailCadenceOf,
  normalizeMailSchedule,
  plannedByScheduler,
  runsAtLeastAsOften,
  scheduleGaps,
  scheduleKey,
  staleBackupHours,
  validateJobSchedule,
} from "./schedule.js";

const NOW = new Date("2026-10-02T10:00:00.000Z");
const ZONE = "Europe/Berlin";

describe("mail schedules", () => {
  it("turns a daily time into its cron expression", () => {
    expect(mailCadenceOf({ kind: "daily", timeOfDay: "02:30", timeZone: ZONE })).toEqual({
      intervalMinutes: null,
      cron: "30 2 * * *",
      timezone: ZONE,
    });
    expect(normalizeMailSchedule({ kind: "daily", timeOfDay: "02:05", timeZone: ZONE })).toEqual({
      kind: "cron",
      cron: "5 2 * * *",
      timeZone: ZONE,
    });
  });

  it("keeps an interval and a cron expression as they are", () => {
    expect(
      normalizeMailSchedule({ kind: "interval", intervalMinutes: 480, timeZone: ZONE }),
    ).toEqual({
      kind: "interval",
      intervalMinutes: 480,
      timeZone: ZONE,
    });
    expect(normalizeMailSchedule({ kind: "cron", cron: " 0 3 * * 0 ", timeZone: ZONE })).toEqual({
      kind: "cron",
      cron: "0 3 * * 0",
      timeZone: ZONE,
    });
  });

  it("has no cadence for a schedule a mail job cannot have", () => {
    expect(mailCadenceOf({ kind: "on_connect", intervalMinutes: 240, timeZone: ZONE })).toBeNull();
    expect(mailCadenceOf({ kind: "interval", timeZone: ZONE })).toBeNull();
  });

  it("validates with the field named", () => {
    expect(
      validateJobSchedule("mail", { kind: "interval", intervalMinutes: 480, timeZone: ZONE }, NOW),
    ).toBeNull();
    expect(
      validateJobSchedule("mail", { kind: "interval", intervalMinutes: 5, timeZone: ZONE }, NOW),
    ).toMatchObject({ path: ["schedule", "intervalMinutes"], code: "interval_out_of_range" });
    expect(
      validateJobSchedule("mail", { kind: "cron", cron: "* * * * *", timeZone: ZONE }, NOW),
    ).toMatchObject({ path: ["schedule", "cron"], code: "cron_too_frequent" });
    expect(
      validateJobSchedule("mail", { kind: "daily", timeOfDay: "25:00", timeZone: ZONE }, NOW),
    ).toMatchObject({ path: ["schedule", "timeOfDay"] });
    expect(
      validateJobSchedule("mail", { kind: "cron", cron: "0 3 * * 0", timeZone: "Mars/Base" }, NOW),
    ).toMatchObject({ path: ["schedule", "timeZone"], code: "timezone_unknown" });
    expect(
      validateJobSchedule("mail", { kind: "on_connect", timeZone: ZONE }, NOW, "verifySchedule"),
    ).toMatchObject({ path: ["verifySchedule", "kind"], code: "schedule_kind_not_supported" });
  });
});

describe("file share and copy schedules (docs/FILESHARES.md 7.5)", () => {
  it("are planned like mail jobs, at most once an hour", () => {
    for (const kind of ["share", "copy"] as const) {
      expect(
        validateJobSchedule(kind, { kind: "daily", timeOfDay: "22:00", timeZone: ZONE }, NOW),
      ).toBeNull();
      expect(
        validateJobSchedule(kind, { kind: "interval", intervalMinutes: 60, timeZone: ZONE }, NOW),
      ).toBeNull();
      expect(
        validateJobSchedule(kind, { kind: "interval", intervalMinutes: 30, timeZone: ZONE }, NOW)
          ?.code,
      ).toBe("interval_out_of_range");
      expect(validateJobSchedule(kind, { kind: "on_connect", timeZone: ZONE }, NOW)?.code).toBe(
        "schedule_kind_not_supported",
      );
    }
    expect(plannedByScheduler("share")).toBe(true);
    expect(plannedByScheduler("endpoint")).toBe(false);
  });
});

describe("endpoint schedules", () => {
  it("follows the agent contract", () => {
    expect(
      validateJobSchedule("endpoint", { kind: "daily", timeOfDay: "22:00", timeZone: ZONE }, NOW),
    ).toBeNull();
    expect(
      validateJobSchedule(
        "endpoint",
        { kind: "on_connect", intervalMinutes: 240, timeZone: ZONE },
        NOW,
      ),
    ).toBeNull();
    expect(
      validateJobSchedule(
        "endpoint",
        { kind: "interval", intervalMinutes: 4, timeZone: ZONE },
        NOW,
      ),
    ).toMatchObject({ code: "interval_out_of_range" });
    expect(
      validateJobSchedule("endpoint", { kind: "interval", timeZone: ZONE }, NOW),
    ).toMatchObject({ path: ["schedule", "intervalMinutes"], code: "required" });
    expect(
      validateJobSchedule("endpoint", { kind: "daily", timeOfDay: "7:00", timeZone: ZONE }, NOW),
    ).toMatchObject({ path: ["schedule", "timeOfDay"] });
    expect(
      validateJobSchedule("endpoint", { kind: "cron", cron: "0 3 * * *", timeZone: ZONE }, NOW),
    ).toMatchObject({ code: "schedule_kind_not_supported" });
  });

  it("hands the agent only the fields of its kind, in a fixed order", () => {
    expect(
      endpointScheduleOf({
        kind: "daily",
        timeOfDay: "02:00",
        intervalMinutes: 60,
        timeZone: ZONE,
      }),
    ).toEqual({ kind: "daily", timeOfDay: "02:00", timeZone: ZONE });
    expect(endpointScheduleOf({ kind: "on_connect", timeZone: ZONE })).toEqual({
      kind: "on_connect",
      timeZone: ZONE,
    });
  });

  it("round-trips the agent's own schedule", () => {
    const schedule = { kind: "on_connect" as const, intervalMinutes: 240, timeZone: ZONE };
    expect(endpointScheduleOf(jobScheduleFromEndpoint(schedule))).toEqual(schedule);
  });
});

describe("schedule keys and gaps", () => {
  it("tells schedules apart and ignores the zone of an interval", () => {
    expect(
      scheduleKey(jobScheduleFromCadence({ intervalMinutes: 60, cron: null, timezone: "UTC" })),
    ).toBe(scheduleKey({ kind: "interval", intervalMinutes: 60, timeZone: ZONE }));
    expect(scheduleKey({ kind: "cron", cron: "0  3 * * 0", timeZone: ZONE })).toBe(
      scheduleKey({ kind: "cron", cron: "0 3 * * 0", timeZone: ZONE }),
    );
    expect(scheduleKey(null)).toBe("none");
  });

  it("measures the shortest and the longest gap of a schedule over the next weeks", () => {
    expect(scheduleGaps({ kind: "interval", intervalMinutes: 480, timeZone: ZONE }, NOW)).toEqual({
      min: 480,
      max: 480,
    });
    // Daily at 03:00 in Berlin: the end of summer time on 25 October makes one day 25 hours long.
    expect(scheduleGaps({ kind: "cron", cron: "0 3 * * *", timeZone: ZONE }, NOW)).toEqual({
      min: 24 * 60,
      max: 25 * 60,
    });
    expect(scheduleGaps({ kind: "cron", cron: "0 3 * * 0", timeZone: "UTC" }, NOW)).toEqual({
      min: 7 * 24 * 60,
      max: 7 * 24 * 60,
    });
    // Office hours on weekdays: 30 minutes apart, but Friday 17:30 to Monday 09:00 without a run.
    const office = scheduleGaps({ kind: "cron", cron: "*/30 9-17 * * 1-5", timeZone: "UTC" }, NOW);
    expect(office).toEqual({ min: 30, max: (2 * 24 + 15) * 60 + 30 });
    expect(scheduleGaps({ kind: "cron", cron: "nonsense", timeZone: ZONE }, NOW)).toBeNull();
  });

  it("calls a schedule at least as frequent only when its longest pause fits the other's shortest gap", () => {
    const daily = scheduleGaps({ kind: "cron", cron: "0 2 * * *", timeZone: "UTC" }, NOW);
    const hourly = scheduleGaps({ kind: "interval", intervalMinutes: 60, timeZone: "UTC" }, NOW);
    const office = scheduleGaps({ kind: "cron", cron: "*/30 9-17 * * 1-5", timeZone: "UTC" }, NOW);
    expect(runsAtLeastAsOften(hourly, daily)).toBe(true);
    expect(runsAtLeastAsOften(daily, daily)).toBe(true);
    expect(runsAtLeastAsOften(office, daily)).toBe(false);
    expect(runsAtLeastAsOften(daily, hourly)).toBe(false);
    expect(runsAtLeastAsOften(null, daily)).toBe(false);
  });
});

describe("staleBackupHours", () => {
  it("falls back to two days without a usable schedule", () => {
    expect(staleBackupHours([], NOW)).toBe(DEFAULT_STALE_BACKUP_HOURS);
    expect(staleBackupHours([null, { kind: "on_connect", timeZone: ZONE }], NOW)).toBe(48);
  });

  it("allows twice the longest gap of the most relaxed schedule", () => {
    expect(staleBackupHours([{ kind: "daily", timeOfDay: "22:00", timeZone: ZONE }], NOW)).toBe(48);
    // Weekly on Sunday: a backup five days old is not overdue yet.
    expect(staleBackupHours([{ kind: "cron", cron: "0 2 * * 0", timeZone: "UTC" }], NOW)).toBe(336);
    expect(
      staleBackupHours(
        [
          { kind: "interval", intervalMinutes: 60, timeZone: ZONE },
          { kind: "cron", cron: "0 2 * * 0", timeZone: "UTC" },
        ],
        NOW,
      ),
    ).toBe(336);
  });

  it("never reads a single missed run of a frequent job as overdue", () => {
    expect(staleBackupHours([{ kind: "interval", intervalMinutes: 60, timeZone: ZONE }], NOW)).toBe(
      MIN_STALE_BACKUP_HOURS,
    );
  });

  it("knows the gap of every endpoint schedule kind", () => {
    expect(
      longestPlannedGapMinutes({ kind: "daily", timeOfDay: "01:00", timeZone: ZONE }, NOW),
    ).toBe(1440);
    expect(
      longestPlannedGapMinutes({ kind: "on_connect", intervalMinutes: 720, timeZone: ZONE }, NOW),
    ).toBe(720);
  });
});
