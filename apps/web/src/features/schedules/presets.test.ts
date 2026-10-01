// The same cases as packages/core/src/schedule/presets.test.ts: the form's copy
// of the preset mapping must read and write cadences exactly like the API.
import { describe, expect, it } from "vitest";
import {
  type SchedulePreset,
  cadenceFromPreset,
  formatWeekdays,
  presetFromCadence,
} from "./presets.js";

const cron = (expression: string) => ({ intervalMinutes: null, cron: expression });
const interval = (minutes: number) => ({ intervalMinutes: minutes, cron: null });

describe("presetFromCadence", () => {
  it("reads intervals as hours when they are whole hours, minutes otherwise", () => {
    expect(presetFromCadence(interval(480))).toEqual({ type: "every_hours", hours: 8 });
    expect(presetFromCadence(interval(90))).toEqual({ type: "every_minutes", minutes: 90 });
  });

  it("reads daily, weekly and monthly expressions", () => {
    expect(presetFromCadence(cron("30 4 * * *"))).toEqual({ type: "daily", hour: 4, minute: 30 });
    expect(presetFromCadence(cron("0 3 * * 0"))).toEqual({
      type: "weekly",
      days: [0],
      hour: 3,
      minute: 0,
    });
    expect(presetFromCadence(cron("15 22 * * 1-5"))).toEqual({
      type: "weekly",
      days: [1, 2, 3, 4, 5],
      hour: 22,
      minute: 15,
    });
    // 7 is Sunday as well; every day of the week is simply daily.
    expect(presetFromCadence(cron("0 6 * * 6,7"))).toMatchObject({ days: [0, 6] });
    expect(presetFromCadence(cron("0 6 * * 0-6"))).toEqual({ type: "daily", hour: 6, minute: 0 });
    expect(presetFromCadence(cron("0 5 1 * *"))).toEqual({
      type: "monthly",
      dayOfMonth: 1,
      hour: 5,
      minute: 0,
    });
  });

  it("keeps everything else as the custom expression", () => {
    for (const expression of [
      "*/15 * * * *",
      "0 3,15 * * *",
      "0 3 * 1 *",
      "0 3 1 * 1",
      "0 3 31 * *",
      "0 3 * * 1-5/2",
      "garbage",
    ]) {
      expect(presetFromCadence(cron(expression))).toEqual({ type: "custom", cron: expression });
    }
  });
});

describe("cadenceFromPreset", () => {
  it("builds intervals and cron expressions", () => {
    expect(cadenceFromPreset({ type: "every_hours", hours: 8 })).toEqual(interval(480));
    expect(cadenceFromPreset({ type: "every_minutes", minutes: 45 })).toEqual(interval(45));
    expect(cadenceFromPreset({ type: "daily", hour: 4, minute: 30 })).toEqual(cron("30 4 * * *"));
    expect(
      cadenceFromPreset({ type: "weekly", days: [5, 1, 2, 3, 4], hour: 3, minute: 0 }),
    ).toEqual(cron("0 3 * * 1-5"));
    expect(
      cadenceFromPreset({ type: "weekly", days: [0, 1, 2, 3, 4, 5, 6], hour: 3, minute: 0 }),
    ).toEqual(cron("0 3 * * *"));
    expect(cadenceFromPreset({ type: "monthly", dayOfMonth: 1, hour: 5, minute: 0 })).toEqual(
      cron("0 5 1 * *"),
    );
    expect(cadenceFromPreset({ type: "custom", cron: "  0 */6 * * *  " })).toEqual(
      cron("0 */6 * * *"),
    );
  });

  it("round-trips every preset", () => {
    const presets: SchedulePreset[] = [
      { type: "every_hours", hours: 6 },
      { type: "every_minutes", minutes: 20 },
      { type: "daily", hour: 23, minute: 59 },
      { type: "weekly", days: [0, 6], hour: 4, minute: 0 },
      { type: "weekly", days: [1, 2, 3], hour: 4, minute: 0 },
      { type: "monthly", dayOfMonth: 28, hour: 0, minute: 0 },
      { type: "custom", cron: "0 3,15 * * *" },
    ];
    for (const preset of presets) {
      expect(presetFromCadence(cadenceFromPreset(preset))).toEqual(preset);
    }
  });

  it("rejects values a preset cannot hold", () => {
    expect(() => cadenceFromPreset({ type: "daily", hour: 24, minute: 0 })).toThrow(RangeError);
    expect(() => cadenceFromPreset({ type: "daily", hour: 3, minute: 60 })).toThrow(RangeError);
    expect(() => cadenceFromPreset({ type: "weekly", days: [], hour: 3, minute: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      cadenceFromPreset({ type: "monthly", dayOfMonth: 31, hour: 3, minute: 0 }),
    ).toThrow(RangeError);
    expect(() => cadenceFromPreset({ type: "every_hours", hours: 0 })).toThrow(RangeError);
  });
});

describe("formatWeekdays", () => {
  it("compresses runs of three or more days into ranges", () => {
    expect(formatWeekdays([1, 2, 3, 4, 5])).toBe("1-5");
    expect(formatWeekdays([0, 6])).toBe("0,6");
    expect(formatWeekdays([1, 2, 4, 5, 6])).toBe("1,2,4-6");
    expect(formatWeekdays([3, 3, 1])).toBe("1,3");
  });
});
