import { describe, expect, it } from "vitest";
import {
  type BandwidthWindow,
  MAX_BANDWIDTH_KBPS,
  MAX_BANDWIDTH_WINDOWS,
  activeBandwidthWindow,
  bandwidthTimeZone,
  bandwidthWindowEndsNextDay,
  bandwidthWindowIssues,
  bandwidthWindowMinutes,
  bandwidthWindowsOverlap,
  effectiveBandwidthKbps,
  firstBandwidthWindowIssue,
  minutesOfDay,
  normalizeBandwidthWindows,
} from "./bandwidth.js";

const window = (days: number[], from: string, to: string, kbps: number): BandwidthWindow => ({
  days,
  from,
  to,
  kbps,
});

const WORKDAYS = [1, 2, 3, 4, 5];
const at = (iso: string) => new Date(iso);

describe("the length of a window", () => {
  it("is the time from start to end, on the next day when the end is not after the start", () => {
    expect(bandwidthWindowMinutes(window([1], "08:00", "18:00", 1))).toBe(600);
    expect(bandwidthWindowMinutes(window([1], "22:00", "06:00", 1))).toBe(480);
    expect(bandwidthWindowMinutes(window([1], "23:59", "00:00", 1))).toBe(1);
    expect(bandwidthWindowEndsNextDay(window([1], "22:00", "06:00", 1))).toBe(true);
    expect(bandwidthWindowEndsNextDay(window([1], "08:00", "18:00", 1))).toBe(false);
  });

  it("lasts 24 hours when start and end are the same", () => {
    expect(bandwidthWindowMinutes(window([1], "00:00", "00:00", 1))).toBe(1440);
    expect(bandwidthWindowMinutes(window([1], "08:30", "08:30", 1))).toBe(1440);
    expect(bandwidthWindowEndsNextDay(window([1], "08:30", "08:30", 1))).toBe(true);
  });

  it("reads HH:MM and nothing else", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("23:59")).toBe(1439);
    for (const bad of ["24:00", "7:30", "12:60", "1200", "", "12:5", null, undefined, 1230]) {
      expect(minutesOfDay(bad)).toBeNull();
    }
  });
});

describe("validating windows", () => {
  const ok = window(WORKDAYS, "08:00", "18:00", 2000);

  it("accepts no windows, one window and windows that touch", () => {
    expect(bandwidthWindowIssues([])).toEqual([]);
    expect(bandwidthWindowIssues([ok])).toEqual([]);
    expect(
      bandwidthWindowIssues([
        window([1], "08:00", "12:00", 100),
        window([1], "12:00", "14:00", 0),
        window([1], "14:00", "08:00", 500),
      ]),
    ).toEqual([]);
    // 0 is a limit: unlimited.
    expect(bandwidthWindowIssues([window([1], "08:00", "12:00", 0)])).toEqual([]);
    expect(bandwidthWindowIssues([window([1], "08:00", "12:00", MAX_BANDWIDTH_KBPS)])).toEqual([]);
  });

  it("asks for days, valid times and a whole limit in range, and names the field", () => {
    expect(bandwidthWindowIssues([window([], "08:00", "18:00", 1)])).toEqual([
      { index: 0, field: "days", code: "days_required" },
    ]);
    for (const days of [[0], [8], [1.5], [-1], [1, 2, 3, 4, 5, 6, 7, 1]]) {
      expect(bandwidthWindowIssues([window(days, "08:00", "18:00", 1)])).toEqual([
        { index: 0, field: "days", code: "days_invalid" },
      ]);
    }
    expect(bandwidthWindowIssues([window([1], "8:00", "18:00", 1)])).toEqual([
      { index: 0, field: "from", code: "time_invalid" },
    ]);
    expect(bandwidthWindowIssues([window([1], "08:00", "24:00", 1)])).toEqual([
      { index: 0, field: "to", code: "time_invalid" },
    ]);
    for (const kbps of [-1, 1.5, MAX_BANDWIDTH_KBPS + 1, Number.NaN]) {
      expect(bandwidthWindowIssues([window([1], "08:00", "18:00", kbps)])).toEqual([
        { index: 0, field: "kbps", code: "kbps_invalid" },
      ]);
    }
  });

  it("refuses more windows than the limit", () => {
    // One hour on one day each, all different: only the count is wrong.
    const many = Array.from({ length: MAX_BANDWIDTH_WINDOWS + 1 }, (_, i) => {
      const hour = Math.floor(i / 7);
      const pad = (value: number) => String(value).padStart(2, "0");
      return window([(i % 7) + 1], `${pad(hour)}:00`, `${pad(hour + 1)}:00`, 1);
    });
    expect(firstBandwidthWindowIssue(many)).toEqual({
      index: null,
      field: "window",
      code: "too_many",
    });
    expect(firstBandwidthWindowIssue(many.slice(0, MAX_BANDWIDTH_WINDOWS))).toBeNull();
  });

  it("reports overlap on the later window and names the other one", () => {
    expect(
      bandwidthWindowIssues([
        window([1, 2], "08:00", "12:00", 100),
        window([3], "08:00", "12:00", 100),
        window([2], "11:00", "14:00", 100),
      ]),
    ).toEqual([{ index: 2, field: "window", code: "overlap", other: 0 }]);
  });

  it("finds overlap across midnight, across the end of the week and with a whole day", () => {
    const overlap = (a: BandwidthWindow, b: BandwidthWindow) => bandwidthWindowsOverlap(a, b);
    // Monday night runs into Tuesday morning.
    expect(overlap(window([1], "22:00", "06:00", 1), window([2], "04:00", "08:00", 1))).toBe(true);
    expect(overlap(window([1], "22:00", "06:00", 1), window([2], "06:00", "08:00", 1))).toBe(false);
    // Sunday night runs into Monday morning, the week's end into its start.
    expect(overlap(window([7], "22:00", "06:00", 1), window([1], "05:00", "07:00", 1))).toBe(true);
    expect(overlap(window([7], "22:00", "06:00", 1), window([1], "06:00", "07:00", 1))).toBe(false);
    // A whole day is every minute of that day, and not of the next.
    expect(overlap(window([1], "00:00", "00:00", 1), window([1], "10:00", "11:00", 1))).toBe(true);
    expect(overlap(window([1], "00:00", "00:00", 1), window([2], "10:00", "11:00", 1))).toBe(false);
    // 24 hours from 08:00 end at 08:00 the next day.
    expect(overlap(window([1], "08:00", "08:00", 1), window([2], "07:00", "09:00", 1))).toBe(true);
    expect(overlap(window([1], "08:00", "08:00", 1), window([2], "08:00", "09:00", 1))).toBe(false);
    // The same hours on other days never meet.
    expect(
      overlap(window([1, 3, 5], "08:00", "18:00", 1), window([2, 4], "08:00", "18:00", 1)),
    ).toBe(false);
  });

  it("does not let a window overlap itself on consecutive days", () => {
    expect(bandwidthWindowIssues([window([1, 2, 3, 4, 5, 6, 7], "22:00", "06:00", 1)])).toEqual([]);
    expect(bandwidthWindowIssues([window([1, 2, 3, 4, 5, 6, 7], "00:00", "00:00", 1)])).toEqual([]);
  });

  it("does not judge overlap between windows that are not well formed", () => {
    expect(
      bandwidthWindowIssues([window([], "08:00", "18:00", 1), window([1], "08:00", "18:00", 1)]),
    ).toEqual([{ index: 0, field: "days", code: "days_required" }]);
  });
});

describe("normalizing windows", () => {
  it("sorts and deduplicates the days and orders the windows by the week", () => {
    expect(
      normalizeBandwidthWindows([
        window([5, 1, 1, 3], "18:00", "22:00", 0),
        window([2], "09:00", "10:00", 100),
        window([1, 2, 3], "06:00", "08:00", 50),
      ]),
    ).toEqual([
      window([1, 2, 3], "06:00", "08:00", 50),
      window([1, 3, 5], "18:00", "22:00", 0),
      window([2], "09:00", "10:00", 100),
    ]);
  });

  it("makes lists that mean the same come out the same, and copies instead of aliasing", () => {
    const a = [window([3, 1], "08:00", "12:00", 100)];
    const b = [window([1, 3], "08:00", "12:00", 100)];
    expect(normalizeBandwidthWindows(a)).toEqual(normalizeBandwidthWindows(b));
    const out = normalizeBandwidthWindows(a);
    expect(out[0]).not.toBe(a[0]);
    expect(a[0]?.days).toEqual([3, 1]);
  });
});

describe("the active window", () => {
  // Monday 2026-10-05 ... Sunday 2026-10-11, no clock change in these days.
  const office = window(WORKDAYS, "08:00", "18:00", 2000);

  it("is active from its start to just before its end, on its days only", () => {
    const list = [office];
    expect(activeBandwidthWindow(list, "UTC", at("2026-10-05T07:59:59Z"))).toBeNull();
    expect(activeBandwidthWindow(list, "UTC", at("2026-10-05T08:00:00Z"))).toBe(office);
    expect(activeBandwidthWindow(list, "UTC", at("2026-10-05T17:59:59Z"))).toBe(office);
    expect(activeBandwidthWindow(list, "UTC", at("2026-10-05T18:00:00Z"))).toBeNull();
    // Friday yes, Saturday no.
    expect(activeBandwidthWindow(list, "UTC", at("2026-10-09T12:00:00Z"))).toBe(office);
    expect(activeBandwidthWindow(list, "UTC", at("2026-10-10T12:00:00Z"))).toBeNull();
    expect(activeBandwidthWindow([], "UTC", at("2026-10-05T12:00:00Z"))).toBeNull();
  });

  it("belongs to the day it starts on when it crosses midnight", () => {
    const night = window(WORKDAYS, "22:00", "06:00", 0);
    const list = [night];
    const active = (iso: string) => activeBandwidthWindow(list, "UTC", at(iso)) === night;
    expect(active("2026-10-05T21:59:00Z")).toBe(false); // Monday, before it starts
    expect(active("2026-10-05T22:00:00Z")).toBe(true); // Monday night
    expect(active("2026-10-06T05:59:00Z")).toBe(true); // Tuesday morning, Monday's window
    expect(active("2026-10-06T06:00:00Z")).toBe(false);
    expect(active("2026-10-09T23:30:00Z")).toBe(true); // Friday night
    expect(active("2026-10-10T03:00:00Z")).toBe(true); // Saturday morning, Friday's window
    expect(active("2026-10-10T22:30:00Z")).toBe(false); // Saturday night: Saturday is not a day
    expect(active("2026-10-11T03:00:00Z")).toBe(false); // Sunday morning
    expect(active("2026-10-12T03:00:00Z")).toBe(false); // Monday morning: Sunday is not a day
    expect(active("2026-10-13T03:00:00Z")).toBe(true); // Tuesday morning again
  });

  it("carries a window from Sunday night into Monday morning", () => {
    const sundayNight = window([7], "22:00", "06:00", 100);
    expect(activeBandwidthWindow([sundayNight], "UTC", at("2026-10-11T23:00:00Z"))).toBe(
      sundayNight,
    );
    expect(activeBandwidthWindow([sundayNight], "UTC", at("2026-10-12T05:59:00Z"))).toBe(
      sundayNight,
    );
    expect(activeBandwidthWindow([sundayNight], "UTC", at("2026-10-12T06:00:00Z"))).toBeNull();
  });

  it("covers exactly one day for 00:00 to 00:00 and exactly 24 hours for equal times", () => {
    const monday = window([1], "00:00", "00:00", 100);
    expect(activeBandwidthWindow([monday], "UTC", at("2026-10-04T23:59:00Z"))).toBeNull();
    expect(activeBandwidthWindow([monday], "UTC", at("2026-10-05T00:00:00Z"))).toBe(monday);
    expect(activeBandwidthWindow([monday], "UTC", at("2026-10-05T23:59:59Z"))).toBe(monday);
    expect(activeBandwidthWindow([monday], "UTC", at("2026-10-06T00:00:00Z"))).toBeNull();
    const fromEight = window([1], "08:00", "08:00", 100);
    expect(activeBandwidthWindow([fromEight], "UTC", at("2026-10-06T07:59:00Z"))).toBe(fromEight);
    expect(activeBandwidthWindow([fromEight], "UTC", at("2026-10-06T08:00:00Z"))).toBeNull();
  });

  it("answers for the window the wall clock of the zone is in, not the one of UTC", () => {
    const list = [office];
    // Monday 2026-10-05 16:30 UTC is 18:30 in Berlin (CEST) and 12:30 in New York (EDT).
    const instant = at("2026-10-05T16:30:00Z");
    expect(activeBandwidthWindow(list, "UTC", instant)).toBe(office);
    expect(activeBandwidthWindow(list, "Europe/Berlin", instant)).toBeNull();
    expect(activeBandwidthWindow(list, "America/New_York", instant)).toBe(office);
    // The day of the week is the zone's too: Monday 22:30 UTC is already Tuesday in Berlin,
    // and Tuesday 01:00 UTC is still Monday in New York.
    const monday = window([1], "00:00", "00:00", 100);
    expect(activeBandwidthWindow([monday], "UTC", at("2026-10-05T22:30:00Z"))).toBe(monday);
    expect(activeBandwidthWindow([monday], "Europe/Berlin", at("2026-10-05T22:30:00Z"))).toBeNull();
    expect(activeBandwidthWindow([monday], "America/New_York", at("2026-10-06T01:00:00Z"))).toBe(
      monday,
    );
    // A zone with a half-hour offset.
    const evening = window([1], "18:00", "19:00", 100);
    expect(activeBandwidthWindow([evening], "Asia/Kolkata", at("2026-10-05T12:45:00Z"))).toBe(
      evening,
    );
    expect(activeBandwidthWindow([evening], "Asia/Kolkata", at("2026-10-05T13:30:00Z"))).toBeNull();
  });

  it("reads an unknown zone as no window", () => {
    expect(activeBandwidthWindow([office], "Mars/Olympus", at("2026-10-05T12:00:00Z"))).toBeNull();
  });

  it("takes the first window of the list when somebody stored an overlap", () => {
    const first = window([1], "08:00", "12:00", 100);
    const second = window([1], "10:00", "14:00", 200);
    expect(activeBandwidthWindow([first, second], "UTC", at("2026-10-05T11:00:00Z"))).toBe(first);
    expect(activeBandwidthWindow([first, second], "UTC", at("2026-10-05T13:00:00Z"))).toBe(second);
  });
});

describe("clock changes (Europe/Berlin)", () => {
  // 2026-03-29: at 02:00 CET the clocks jump to 03:00 CEST (01:00 UTC).
  // 2026-10-25: at 03:00 CEST they go back to 02:00 CET (01:00 UTC).
  const zone = "Europe/Berlin";
  const saturdayNight = window([6], "22:00", "08:00", 0);

  it("keeps the wall times of a night window on the night the clocks go forward", () => {
    const active = (iso: string) => activeBandwidthWindow([saturdayNight], zone, at(iso)) !== null;
    expect(active("2026-03-28T20:59:00Z")).toBe(false); // 21:59 CET
    expect(active("2026-03-28T21:00:00Z")).toBe(true); // 22:00 CET
    expect(active("2026-03-29T00:59:00Z")).toBe(true); // 01:59 CET
    expect(active("2026-03-29T01:00:00Z")).toBe(true); // 03:00 CEST: the gap is gone, the window goes on
    expect(active("2026-03-29T05:59:00Z")).toBe(true); // 07:59 CEST
    expect(active("2026-03-29T06:00:00Z")).toBe(false); // 08:00 CEST: it lasted 9 hours, not 10
  });

  it("keeps the wall times of a night window on the night the clocks go back", () => {
    const active = (iso: string) => activeBandwidthWindow([saturdayNight], zone, at(iso)) !== null;
    expect(active("2026-10-24T19:59:00Z")).toBe(false); // 21:59 CEST
    expect(active("2026-10-24T20:00:00Z")).toBe(true); // 22:00 CEST
    expect(active("2026-10-25T00:30:00Z")).toBe(true); // 02:30 CEST
    expect(active("2026-10-25T01:30:00Z")).toBe(true); // 02:30 CET, the same wall time again
    expect(active("2026-10-25T06:59:00Z")).toBe(true); // 07:59 CET
    expect(active("2026-10-25T07:00:00Z")).toBe(false); // 08:00 CET: it lasted 11 hours
  });

  it("does not apply a window that lies in the hour that does not exist", () => {
    const skipped = window([7], "02:00", "03:00", 100);
    const active = (iso: string) => activeBandwidthWindow([skipped], zone, at(iso)) !== null;
    expect(active("2026-03-29T00:59:00Z")).toBe(false); // 01:59 CET
    expect(active("2026-03-29T01:00:00Z")).toBe(false); // 03:00 CEST: the end is not included
    expect(active("2026-03-29T01:30:00Z")).toBe(false);
    // A week later it is an ordinary hour.
    expect(active("2026-04-05T00:00:00Z")).toBe(true); // 02:00 CEST
    expect(active("2026-04-05T00:59:00Z")).toBe(true);
    expect(active("2026-04-05T01:00:00Z")).toBe(false);
  });

  it("applies a window in the hour that happens twice both times", () => {
    const repeated = window([7], "02:00", "03:00", 100);
    const active = (iso: string) => activeBandwidthWindow([repeated], zone, at(iso)) !== null;
    expect(active("2026-10-25T00:00:00Z")).toBe(true); // 02:00 CEST
    expect(active("2026-10-25T00:59:00Z")).toBe(true); // 02:59 CEST
    expect(active("2026-10-25T01:00:00Z")).toBe(true); // 02:00 CET
    expect(active("2026-10-25T01:59:00Z")).toBe(true); // 02:59 CET
    expect(active("2026-10-25T02:00:00Z")).toBe(false); // 03:00 CET
  });

  it("changes the day at local midnight, not at UTC midnight, around a clock change", () => {
    const sunday = window([7], "00:00", "00:00", 100);
    const active = (iso: string) => activeBandwidthWindow([sunday], zone, at(iso)) !== null;
    expect(active("2026-03-28T22:59:00Z")).toBe(false); // 23:59 CET Saturday
    expect(active("2026-03-28T23:00:00Z")).toBe(true); // 00:00 CET Sunday
    expect(active("2026-03-29T21:59:00Z")).toBe(true); // 23:59 CEST Sunday
    expect(active("2026-03-29T22:00:00Z")).toBe(false); // 00:00 CEST Monday
  });
});

describe("the limit that applies", () => {
  const list = normalizeBandwidthWindows([
    window(WORKDAYS, "08:00", "18:00", 2000),
    window(WORKDAYS, "22:00", "06:00", 0),
  ]);
  const zone = "Europe/Berlin";

  it("is the active window's limit, else the default", () => {
    // Tuesday 2026-10-06, Berlin is on CEST (UTC+2).
    expect(effectiveBandwidthKbps(500, list, zone, at("2026-10-06T08:00:00Z"))).toBe(2000); // 10:00
    expect(effectiveBandwidthKbps(500, list, zone, at("2026-10-06T17:00:00Z"))).toBe(500); // 19:00
    expect(effectiveBandwidthKbps(null, list, zone, at("2026-10-06T17:00:00Z"))).toBeNull();
  });

  it("is unlimited (null) in a window of 0, even under a default limit", () => {
    expect(effectiveBandwidthKbps(500, list, zone, at("2026-10-06T21:00:00Z"))).toBeNull(); // 23:00
    expect(effectiveBandwidthKbps(500, list, zone, at("2026-10-07T02:00:00Z"))).toBeNull(); // 04:00 Wednesday, Tuesday's night
  });

  it("is the default without windows, and never 0", () => {
    expect(effectiveBandwidthKbps(500, undefined, zone, at("2026-10-06T08:00:00Z"))).toBe(500);
    expect(effectiveBandwidthKbps(500, [], zone, at("2026-10-06T08:00:00Z"))).toBe(500);
    expect(effectiveBandwidthKbps(null, undefined, zone, at("2026-10-06T08:00:00Z"))).toBeNull();
    expect(
      effectiveBandwidthKbps(undefined, undefined, zone, at("2026-10-06T08:00:00Z")),
    ).toBeNull();
    expect(effectiveBandwidthKbps(0, undefined, zone, at("2026-10-06T08:00:00Z"))).toBeNull();
  });

  it("changes at the minute a window starts or ends, which is what a run that starts then sees", () => {
    const answer = (iso: string) => effectiveBandwidthKbps(500, list, zone, at(iso));
    expect(answer("2026-10-06T05:59:59Z")).toBe(500); // 07:59:59
    expect(answer("2026-10-06T06:00:00Z")).toBe(2000); // 08:00:00
    expect(answer("2026-10-06T15:59:59Z")).toBe(2000); // 17:59:59
    expect(answer("2026-10-06T16:00:00Z")).toBe(500); // 18:00:00
  });
});

describe("the zone windows are read in", () => {
  it("is the schedule's zone, else the tenant's, else the installation's default", () => {
    expect(bandwidthTimeZone("Europe/Lisbon", "Asia/Tokyo")).toBe("Europe/Lisbon");
    expect(bandwidthTimeZone(undefined, "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(bandwidthTimeZone("", null, "America/New_York")).toBe("America/New_York");
    expect(bandwidthTimeZone("Not/AZone", "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(bandwidthTimeZone()).toBe("Europe/Berlin");
    expect(bandwidthTimeZone(null, undefined, "nonsense")).toBe("Europe/Berlin");
  });
});
