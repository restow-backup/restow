import { describe, expect, it } from "vitest";

import {
  cadenceOfPveSchedule,
  PVE_PRESET_TYPES,
  pveCadenceDraft,
  pveScheduleOfDraft,
} from "./schedule";

/** E1: a Proxmox VE job takes the mail jobs' cadences, as far as its scheduler plans them. */
describe("PVE job schedules", () => {
  it("reads a daily job as the daily preset and writes it back as daily", () => {
    const draft = pveCadenceDraft({ kind: "daily", timeOfDay: "22:30", timeZone: "UTC" }, "UTC");
    expect(draft).toMatchObject({ presetType: "daily", time: "22:30", timezone: "UTC" });
    expect(pveScheduleOfDraft(draft)).toEqual({
      kind: "daily",
      timeOfDay: "22:30",
      timeZone: "UTC",
    });
  });

  it("keeps intervals of whole hours, weekdays, months and custom expressions", () => {
    const hours = pveCadenceDraft(
      { kind: "interval", intervalMinutes: 360, timeZone: "UTC" },
      "UTC",
    );
    expect(hours).toMatchObject({ presetType: "every_hours", hours: "6" });
    expect(pveScheduleOfDraft(hours)).toEqual({
      kind: "interval",
      intervalMinutes: 360,
      timeZone: "UTC",
    });
    for (const cron of ["30 2 * * 1-5", "0 5 1 * *", "*/30 1-5 * * *"]) {
      const draft = pveCadenceDraft({ kind: "cron", cron, timeZone: "Europe/Berlin" }, "UTC");
      expect(pveScheduleOfDraft(draft)).toEqual({ kind: "cron", cron, timeZone: "Europe/Berlin" });
    }
    expect(cadenceOfPveSchedule({ kind: "daily", timeOfDay: "03:05", timeZone: "UTC" })).toEqual({
      intervalMinutes: null,
      cron: "5 3 * * *",
    });
  });

  it("starts a new job daily at 22:00 and offers no minute intervals", () => {
    expect(pveCadenceDraft(null, "Europe/Berlin")).toMatchObject({
      presetType: "daily",
      time: "22:00",
      timezone: "Europe/Berlin",
    });
    expect(PVE_PRESET_TYPES).not.toContain("every_minutes");
    expect(PVE_PRESET_TYPES).toContain("weekly");
  });

  it("has no schedule while a field needs correcting", () => {
    const draft = {
      ...pveCadenceDraft(null, "UTC"),
      presetType: "every_hours" as const,
      hours: "",
    };
    expect(pveScheduleOfDraft(draft)).toBeNull();
  });
});
