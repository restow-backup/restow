import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarOccurrence } from "@/features/restore/api";

import {
  eventWhen,
  isCalendarListing,
  monthLabel,
  monthWindow,
  occurrencesByDay,
  seriesWindow,
  shiftMonth,
} from "./calendar.js";

function occurrence(start: string, over: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return {
    entryId: "e1",
    entryPath: "calendar/Calendar/x.json",
    entryName: "x.json",
    itemId: null,
    size: 1,
    calendarName: "Calendar",
    kind: "single",
    subject: "x",
    start,
    end: new Date(Date.parse(start) + 3_600_000).toISOString(),
    isAllDay: false,
    location: null,
    organizer: null,
    isCancelled: false,
    ...over,
  };
}

describe("where the explorer shows a calendar", () => {
  it("is the calendar area of a mailbox, nothing else", () => {
    expect(isCalendarListing("mailbox", "calendar")).toBe(true);
    expect(isCalendarListing("mailbox", "calendar/Team")).toBe(true);
    expect(isCalendarListing("mailbox", "mail/Inbox")).toBe(false);
    expect(isCalendarListing("mailbox", "calendars")).toBe(false);
    expect(isCalendarListing("onedrive", "calendar")).toBe(false);
  });
});

describe("months", () => {
  beforeEach(() => {
    vi.stubEnv("TZ", "UTC");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("steps across the turn of the year", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthLabel("2026-10", "en")).toBe("October 2026");
    expect(monthLabel("2026-10", "de")).toBe("Oktober 2026");
  });

  it("asks for a day more on both sides, so all-day events at the edges are in", () => {
    const { from, to } = monthWindow("2026-09");
    expect(Date.parse(from)).toBeLessThan(Date.parse("2026-09-01T00:00:00Z") - 12 * 3_600_000);
    expect(Date.parse(to)).toBeGreaterThan(Date.parse("2026-10-01T00:00:00Z") + 12 * 3_600_000);
  });

  it("groups a month by day, all-day events first, and leaves out the days of the next month", () => {
    const days = occurrencesByDay(
      [
        occurrence("2026-09-14T14:00:00.000Z", { subject: "moved" }),
        occurrence("2026-09-14T08:00:00.000Z", { subject: "early" }),
        occurrence("2026-09-14T00:00:00.000Z", { subject: "holiday", isAllDay: true }),
        occurrence("2026-09-02T09:00:00.000Z", { subject: "first" }),
        occurrence("2026-10-01T00:00:00.000Z", { subject: "next month", isAllDay: true }),
      ],
      "2026-09",
    );
    expect(days.map((day) => [day.key, day.occurrences.map((o) => o.subject)])).toEqual([
      ["2026-09-02", ["first"]],
      ["2026-09-14", ["holiday", "early", "moved"]],
    ]);
  });
});

describe("when an event takes place", () => {
  it("names the date of an all-day event without a time, and its last day when it lasts longer", () => {
    expect(
      eventWhen(
        { start: "2026-09-15T00:00:00.000Z", end: "2026-09-16T00:00:00.000Z", isAllDay: true },
        "en",
      ),
    ).toBe("Sep 15, 2026");
    expect(
      eventWhen(
        { start: "2026-09-15T00:00:00.000Z", end: "2026-09-18T00:00:00.000Z", isAllDay: true },
        "en",
      ),
    ).toMatch(/^Sep 15\s–\s17, 2026$/);
  });

  it("says nothing without a start (a restore point that did not record it)", () => {
    expect(eventWhen({ start: null, end: null, isAllDay: false }, "en")).toBeNull();
  });
});

describe("the occurrences of a series", () => {
  const now = new Date("2026-10-21T12:00:00Z");

  it("run from the start of the series to its end", () => {
    expect(
      seriesWindow({ start: "2026-01-05T10:00:00.000Z", recurrenceEnd: "2026-12-28" }, now),
    ).toEqual({ from: "2026-01-05T10:00:00.000Z", to: "2026-12-29T00:00:00.000Z" });
  });

  it("stop two years ahead for a series without an end, and keep within ten years", () => {
    const open = seriesWindow({ start: "2026-01-05T10:00:00.000Z", recurrenceEnd: null }, now);
    expect(open.to.slice(0, 10)).toBe("2028-10-20");
    const old = seriesWindow({ start: "2000-01-03T10:00:00.000Z", recurrenceEnd: null }, now);
    expect(Date.parse(old.to) - Date.parse(old.from)).toBe(3650 * 86_400_000);
  });
});
