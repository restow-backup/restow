import { describe, expect, it } from "vitest";

import { expandSeries, graphUtcMillis, ianaZoneOf, type RecurringEventLike } from "./recurrence.js";

const at = (iso: string) => Date.parse(iso);
const window = (from: string, to: string) => ({ from: at(from), to: at(to) });
const starts = (events: { start: string }[]) => events.map((event) => event.start);

function master(over: Partial<RecurringEventLike> = {}): RecurringEventLike {
  return {
    type: "seriesMaster",
    subject: "Jour fixe",
    isAllDay: false,
    start: { dateTime: "2026-01-05T08:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-01-05T08:30:00.0000000", timeZone: "UTC" },
    originalStartTimeZone: "W. Europe Standard Time",
    location: { displayName: "Room 1" },
    ...over,
  };
}

describe("time zones", () => {
  it("knows the Windows names Exchange uses and passes IANA names through", () => {
    expect(ianaZoneOf("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(ianaZoneOf("Europe/Vienna")).toBe("Europe/Vienna");
    expect(ianaZoneOf("Nowhere Standard Time")).toBeNull();
    expect(ianaZoneOf(null)).toBeNull();
  });

  it("reads Graph's zone-less UTC times", () => {
    expect(graphUtcMillis("2026-01-05T08:00:00.0000000")).toBe(at("2026-01-05T08:00:00Z"));
    expect(graphUtcMillis("2026-01-05T08:00:00+01:00")).toBe(at("2026-01-05T07:00:00Z"));
    expect(graphUtcMillis("")).toBeNull();
  });
});

describe("a single event", () => {
  it("is its own occurrence inside the window and nothing outside", () => {
    const single = master({ type: "singleInstance", recurrence: null });
    expect(
      starts(
        expandSeries(single, [], window("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"))
          .occurrences,
      ),
    ).toEqual(["2026-01-05T08:00:00.000Z"]);
    expect(
      expandSeries(single, [], window("2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z")).occurrences,
    ).toEqual([]);
  });
});

describe("a weekly series", () => {
  const weekly = master({
    recurrence: {
      pattern: {
        type: "weekly",
        interval: 1,
        daysOfWeek: ["monday", "wednesday"],
        firstDayOfWeek: "monday",
      },
      range: {
        type: "endDate",
        startDate: "2026-01-05",
        endDate: "2026-04-30",
        recurrenceTimeZone: "W. Europe Standard Time",
      },
    },
  });

  it("produces every chosen weekday, keeping the local time across daylight saving", () => {
    const { occurrences } = expandSeries(
      weekly,
      [],
      window("2026-03-23T00:00:00Z", "2026-04-02T00:00:00Z"),
    );
    // 09:00 in Berlin: 08:00 UTC before 29 March, 07:00 UTC after it.
    expect(starts(occurrences)).toEqual([
      "2026-03-23T08:00:00.000Z",
      "2026-03-25T08:00:00.000Z",
      "2026-03-30T07:00:00.000Z",
      "2026-04-01T07:00:00.000Z",
    ]);
    expect(occurrences[0]).toMatchObject({
      kind: "occurrence",
      subject: "Jour fixe",
      location: "Room 1",
    });
    expect(Date.parse(occurrences[0]?.end ?? "") - Date.parse(occurrences[0]?.start ?? "")).toBe(
      30 * 60_000,
    );
  });

  it("ends with its range", () => {
    const { occurrences } = expandSeries(
      weekly,
      [],
      window("2026-04-20T00:00:00Z", "2026-06-01T00:00:00Z"),
    );
    expect(starts(occurrences)).toEqual([
      "2026-04-20T07:00:00.000Z",
      "2026-04-22T07:00:00.000Z",
      "2026-04-27T07:00:00.000Z",
      "2026-04-29T07:00:00.000Z",
    ]);
  });

  it("puts a stored exception in place of the occurrence it changed", () => {
    const exception: RecurringEventLike = {
      type: "exception",
      subject: "Jour fixe (moved)",
      originalStart: "2026-01-07T08:00:00Z",
      start: { dateTime: "2026-01-08T10:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-01-08T11:00:00.0000000", timeZone: "UTC" },
      location: { displayName: "Room 2" },
    };
    const { occurrences } = expandSeries(
      weekly,
      [exception],
      window("2026-01-05T00:00:00Z", "2026-01-13T00:00:00Z"),
    );
    expect(occurrences.map((o) => [o.start, o.kind, o.subject])).toEqual([
      ["2026-01-05T08:00:00.000Z", "occurrence", "Jour fixe"],
      ["2026-01-08T10:00:00.000Z", "exception", "Jour fixe (moved)"],
      ["2026-01-12T08:00:00.000Z", "occurrence", "Jour fixe"],
    ]);
    expect(occurrences[1]).toMatchObject({
      location: "Room 2",
      originalStart: "2026-01-07T08:00:00.000Z",
    });
  });
});

describe("other patterns", () => {
  it("counts a numbered series from its start, also before the window", () => {
    const daily = master({
      recurrence: {
        pattern: { type: "daily", interval: 2 },
        range: { type: "numbered", startDate: "2026-01-05", numberOfOccurrences: 5 },
      },
    });
    const { occurrences } = expandSeries(
      daily,
      [],
      window("2026-01-08T00:00:00Z", "2026-02-01T00:00:00Z"),
    );
    expect(starts(occurrences)).toEqual([
      "2026-01-09T08:00:00.000Z",
      "2026-01-11T08:00:00.000Z",
      "2026-01-13T08:00:00.000Z",
    ]);
  });

  it("finds the last Friday of a month, and the 31st as the last day of a short month", () => {
    const relative = master({
      start: { dateTime: "2026-01-30T15:00:00.0000000" },
      end: { dateTime: "2026-01-30T16:00:00.0000000" },
      recurrence: {
        pattern: { type: "relativeMonthly", interval: 1, daysOfWeek: ["friday"], index: "last" },
        range: { type: "noEnd", startDate: "2026-01-30" },
      },
    });
    expect(
      starts(
        expandSeries(relative, [], window("2026-02-01T00:00:00Z", "2026-05-01T00:00:00Z"))
          .occurrences,
      ),
    ).toEqual(["2026-02-27T15:00:00.000Z", "2026-03-27T15:00:00.000Z", "2026-04-24T14:00:00.000Z"]);
    const absolute = master({
      start: { dateTime: "2026-01-31T08:00:00.0000000" },
      end: { dateTime: "2026-01-31T09:00:00.0000000" },
      originalStartTimeZone: "UTC",
      recurrence: {
        pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: 31 },
        range: { type: "noEnd", startDate: "2026-01-31" },
      },
    });
    expect(
      starts(
        expandSeries(absolute, [], window("2026-02-01T00:00:00Z", "2026-05-01T00:00:00Z"))
          .occurrences,
      ),
    ).toEqual(["2026-02-28T08:00:00.000Z", "2026-03-31T08:00:00.000Z", "2026-04-30T08:00:00.000Z"]);
  });

  it("repeats a birthday every year as an all-day event", () => {
    const birthday = master({
      isAllDay: true,
      start: { dateTime: "2020-03-14T00:00:00.0000000" },
      end: { dateTime: "2020-03-15T00:00:00.0000000" },
      recurrence: {
        pattern: { type: "absoluteYearly", interval: 1, month: 3, dayOfMonth: 14 },
        range: { type: "noEnd", startDate: "2020-03-14" },
      },
    });
    const { occurrences } = expandSeries(
      birthday,
      [],
      window("2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"),
    );
    expect(starts(occurrences)).toEqual(["2026-03-14T00:00:00.000Z", "2027-03-14T00:00:00.000Z"]);
    expect(occurrences[0]?.isAllDay).toBe(true);
  });

  it("stops at the limit and says so", () => {
    const daily = master({
      recurrence: {
        pattern: { type: "daily", interval: 1 },
        range: { type: "noEnd", startDate: "2026-01-05" },
      },
    });
    const expansion = expandSeries(
      daily,
      [],
      window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"),
      10,
    );
    expect(expansion.occurrences).toHaveLength(10);
    expect(expansion.truncated).toBe(true);
  });
});
