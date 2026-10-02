import { describe, expect, it } from "vitest";

import {
  type BandwidthWindow,
  WINDOW_LIMITS,
  type WindowDraft,
  checkWindowDrafts,
  daysText,
  endsNextDay,
  newWindowDraft,
  weekdayName,
  windowDraftsOf,
  windowLength,
  windowsKey,
  windowsOfDrafts,
  windowsOverlap,
} from "./bandwidth-windows.js";

/**
 * The editor's mirror of the rules in packages/core backup-jobs/bandwidth.ts. The overlap table
 * below is the one core tests too: a change to one side that the other does not follow fails
 * here or there.
 */

const draft = (
  days: number[],
  from: string,
  to: string,
  kbps: string,
  key = "w0",
): WindowDraft => ({ key, days, from, to, kbps });

describe("how long a window lasts", () => {
  it("is the time from start to end, on the next day when the end is not after the start", () => {
    expect(windowLength("08:00", "18:00")).toBe(600);
    expect(windowLength("22:00", "06:00")).toBe(480);
    expect(windowLength("23:59", "00:00")).toBe(1);
    expect(endsNextDay("22:00", "06:00")).toBe(true);
    expect(endsNextDay("08:00", "18:00")).toBe(false);
  });

  it("is 24 hours for the same time twice", () => {
    expect(windowLength("00:00", "00:00")).toBe(1440);
    expect(windowLength("08:30", "08:30")).toBe(1440);
    expect(endsNextDay("08:30", "08:30")).toBe(true);
  });
});

describe("overlap", () => {
  const win = (days: number[], from: string, to: string) => ({ days, from, to });
  it("agrees with the server on across midnight, across the week's end and with a whole day", () => {
    expect(windowsOverlap(win([1], "22:00", "06:00"), win([2], "04:00", "08:00"))).toBe(true);
    expect(windowsOverlap(win([1], "22:00", "06:00"), win([2], "06:00", "08:00"))).toBe(false);
    expect(windowsOverlap(win([7], "22:00", "06:00"), win([1], "05:00", "07:00"))).toBe(true);
    expect(windowsOverlap(win([7], "22:00", "06:00"), win([1], "06:00", "07:00"))).toBe(false);
    expect(windowsOverlap(win([1], "00:00", "00:00"), win([1], "10:00", "11:00"))).toBe(true);
    expect(windowsOverlap(win([1], "00:00", "00:00"), win([2], "10:00", "11:00"))).toBe(false);
    expect(windowsOverlap(win([1], "08:00", "08:00"), win([2], "07:00", "09:00"))).toBe(true);
    expect(windowsOverlap(win([1], "08:00", "08:00"), win([2], "08:00", "09:00"))).toBe(false);
    expect(windowsOverlap(win([1, 3, 5], "08:00", "18:00"), win([2, 4], "08:00", "18:00"))).toBe(
      false,
    );
    expect(windowsOverlap(win([1], "08:00", "12:00"), win([1], "12:00", "14:00"))).toBe(false);
  });
});

describe("checking the rows", () => {
  it("accepts no rows, a good row and rows that touch", () => {
    expect(checkWindowDrafts([]).invalid).toBe(false);
    expect(checkWindowDrafts([draft([1, 2], "08:00", "18:00", "2000")]).invalid).toBe(false);
    expect(
      checkWindowDrafts([
        draft([1], "08:00", "12:00", "100", "w0"),
        draft([1], "12:00", "14:00", "0", "w1"),
        draft([1], "14:00", "08:00", "500", "w2"),
      ]).invalid,
    ).toBe(false);
  });

  it("says what is wrong in a row, at the field", () => {
    const check = checkWindowDrafts([draft([], "", "24:00", "")]);
    expect(check.invalid).toBe(true);
    expect(check.rows[0]).toEqual({
      days: { code: "days" },
      from: { code: "time" },
      to: { code: "time" },
      kbps: { code: "kbpsRequired" },
    });
  });

  it("wants a whole number of kbit/s from 0 to the maximum", () => {
    const kbps = (text: string) =>
      checkWindowDrafts([draft([1], "08:00", "18:00", text)]).rows[0]?.kbps;
    expect(kbps("0")).toBeUndefined();
    expect(kbps(" 250 ")).toBeUndefined();
    expect(kbps(String(WINDOW_LIMITS.kbpsMax))).toBeUndefined();
    for (const bad of ["fast", "1.5", "-1", "1e3", String(WINDOW_LIMITS.kbpsMax + 1)]) {
      expect(kbps(bad), bad).toEqual({ code: "kbps", values: { max: WINDOW_LIMITS.kbpsMax } });
    }
    expect(kbps("")).toEqual({ code: "kbpsRequired" });
  });

  it("says overlap on the later row and names the other by its number", () => {
    const check = checkWindowDrafts([
      draft([1, 2], "08:00", "12:00", "100", "w0"),
      draft([3], "08:00", "12:00", "100", "w1"),
      draft([2], "11:00", "14:00", "100", "w2"),
    ]);
    expect(check.invalid).toBe(true);
    expect(check.rows[0]).toEqual({});
    expect(check.rows[1]).toEqual({});
    expect(check.rows[2]?.window).toEqual({ code: "overlap", values: { other: 1 } });
  });

  it("still finds an overlap while a limit is not typed yet", () => {
    const check = checkWindowDrafts([
      draft([1], "08:00", "12:00", "", "w0"),
      draft([1], "11:00", "14:00", "100", "w1"),
    ]);
    expect(check.rows[1]?.window?.code).toBe("overlap");
    expect(check.rows[0]?.kbps?.code).toBe("kbpsRequired");
  });

  it("refuses more rows than the server takes", () => {
    const many = Array.from({ length: WINDOW_LIMITS.windows + 1 }, (_, i) =>
      draft(
        [(i % 7) + 1],
        `${String(Math.floor(i / 7)).padStart(2, "0")}:00`,
        `${String(Math.floor(i / 7) + 1).padStart(2, "0")}:00`,
        "1",
        `w${i}`,
      ),
    );
    expect(checkWindowDrafts(many).list).toEqual({
      code: "tooMany",
      values: { max: WINDOW_LIMITS.windows },
    });
    expect(checkWindowDrafts(many.slice(0, WINDOW_LIMITS.windows)).invalid).toBe(false);
  });
});

describe("rows and windows", () => {
  const windows: BandwidthWindow[] = [
    { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
    { days: [6, 7], from: "00:00", to: "00:00", kbps: 0 },
  ];

  it("makes rows from windows and windows from rows, the same ones", () => {
    const rows = windowDraftsOf(windows);
    expect(rows.map((row) => row.key)).toEqual(["w0", "w1"]);
    expect(rows[1]).toMatchObject({ days: [6, 7], kbps: "0" });
    expect(windowsOfDrafts(rows)).toEqual(windows);
    expect(windowDraftsOf(undefined)).toEqual([]);
  });

  it("sends the windows in the order of the week, each day once", () => {
    const rows = [
      draft([7, 6, 6], "00:00", "00:00", "0", "w0"),
      draft([5, 1, 3], "22:00", "06:00", "100", "w1"),
      draft([1, 2], "08:00", "17:00", "2000", "w2"),
    ];
    expect(windowsOfDrafts(rows)).toEqual([
      { days: [1, 2], from: "08:00", to: "17:00", kbps: 2000 },
      { days: [1, 3, 5], from: "22:00", to: "06:00", kbps: 100 },
      { days: [6, 7], from: "00:00", to: "00:00", kbps: 0 },
    ]);
  });

  it("tells two lists apart by what they mean, not by their order or spelling", () => {
    const a: BandwidthWindow[] = [
      { days: [3, 1], from: "08:00", to: "12:00", kbps: 100 },
      { days: [2], from: "09:00", to: "10:00", kbps: 5 },
    ];
    const b: BandwidthWindow[] = [
      { days: [2], from: "09:00", to: "10:00", kbps: 5 },
      { days: [1, 3], from: "08:00", to: "12:00", kbps: 100 },
    ];
    expect(windowsKey(a)).toBe(windowsKey(b));
    expect(windowsKey(a)).not.toBe(windowsKey([a[0] as BandwidthWindow]));
    expect(windowsKey(undefined)).toBe(windowsKey([]));
  });

  it("starts a new row on office hours of the working days, with a key no other row has", () => {
    const first = newWindowDraft([]);
    expect(first).toEqual({
      key: "w0",
      days: [1, 2, 3, 4, 5],
      from: "08:00",
      to: "18:00",
      kbps: "",
    });
    const rows = [first, { ...first, key: "w1" }, { ...first, key: "w4" }];
    expect(newWindowDraft(rows).key).toBe("w5");
  });
});

describe("the words about a window", () => {
  it("names the days in the language of the viewer", () => {
    expect(weekdayName(1, "en")).toBe("Mon");
    expect(weekdayName(7, "en")).toBe("Sun");
    expect(weekdayName(1, "en", "long")).toBe("Monday");
    expect(weekdayName(1, "de")).toBe("Mo");
    expect(weekdayName(3, "de", "long")).toBe("Mittwoch");
  });

  it("writes runs of three or more days as a range and lists the rest", () => {
    expect(daysText([1, 2, 3, 4, 5], "en")).toBe("Mon–Fri");
    expect(daysText([6, 7], "en")).toBe("Sat, Sun");
    expect(daysText([1, 3, 5], "en")).toBe("Mon, Wed, Fri");
    expect(daysText([1, 2, 3, 5, 6, 7], "en")).toBe("Mon–Wed, Fri–Sun");
    expect(daysText([5, 1, 1, 2], "en")).toBe("Mon, Tue, Fri");
    expect(daysText([1, 2, 3, 4, 5, 6, 7], "de")).toBe("Mo–So");
    expect(daysText([], "en")).toBe("");
  });
});
