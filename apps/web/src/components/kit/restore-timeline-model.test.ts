import { describe, expect, it } from "vitest";

import {
  dayAtOrBefore,
  dayRelation,
  groupByLocalDay,
  localDayKey,
} from "./restore-timeline-model.js";

/** A local time (not UTC), so the tests hold in every time zone. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).toISOString();

interface Point {
  id: string;
  time: string | null;
}

describe("groupByLocalDay", () => {
  it("groups by local day, newest day and newest time first, whatever the input order", () => {
    const points: Point[] = [
      { id: "a", time: at(2026, 9, 28, 9) },
      { id: "b", time: at(2026, 9, 30, 8) },
      { id: "c", time: at(2026, 9, 30, 22, 15) },
      { id: "d", time: at(2026, 9, 28, 23, 59) },
    ];
    const days = groupByLocalDay(points, (point) => point.time);
    expect(days.map((day) => day.key)).toEqual(["2026-09-30", "2026-09-28"]);
    expect(days[0]?.items.map((point) => point.id)).toEqual(["c", "b"]);
    expect(days[1]?.items.map((point) => point.id)).toEqual(["d", "a"]);
    expect(days[1]?.date).toEqual(new Date(2026, 8, 28));
  });

  it("keeps a point just after local midnight on its own day", () => {
    const days = groupByLocalDay(
      [
        { id: "late", time: at(2026, 9, 29, 23, 59) },
        { id: "early", time: at(2026, 9, 30, 0, 1) },
      ],
      (point: Point) => point.time,
    );
    expect(days.map((day) => [day.key, day.items.map((point) => point.id)])).toEqual([
      ["2026-09-30", ["early"]],
      ["2026-09-29", ["late"]],
    ]);
  });

  it("leaves out points without a readable time and is empty for no points", () => {
    const days = groupByLocalDay(
      [
        { id: "x", time: null },
        { id: "y", time: "not a date" },
        { id: "z", time: at(2026, 1, 2) },
      ],
      (point: Point) => point.time,
    );
    expect(days.map((day) => day.items.map((point) => point.id))).toEqual([["z"]]);
    expect(groupByLocalDay([], (point: Point) => point.time)).toEqual([]);
  });
});

describe("dayRelation", () => {
  const now = new Date(2026, 9, 3, 10, 0);

  it("names today and yesterday, across a month boundary too", () => {
    expect(dayRelation(new Date(2026, 9, 3), now)).toBe("today");
    expect(dayRelation(new Date(2026, 9, 2), now)).toBe("yesterday");
    expect(dayRelation(new Date(2026, 9, 1), now)).toBe("other");
    expect(dayRelation(new Date(2026, 8, 30), new Date(2026, 9, 1, 0, 5))).toBe("yesterday");
  });
});

describe("dayAtOrBefore", () => {
  const days = groupByLocalDay(
    [
      { id: "newest", time: at(2026, 9, 30) },
      { id: "middle", time: at(2026, 9, 20) },
      { id: "oldest", time: at(2026, 9, 1) },
    ],
    (point: Point) => point.time,
  );

  it("lands on the chosen day when it has restore points", () => {
    expect(dayAtOrBefore(days, new Date(2026, 8, 20, 18))?.key).toBe("2026-09-20");
  });

  it("lands on the nearest earlier day otherwise", () => {
    expect(dayAtOrBefore(days, new Date(2026, 8, 25))?.key).toBe("2026-09-20");
    expect(dayAtOrBefore(days, new Date(2026, 9, 15))?.key).toBe("2026-09-30");
  });

  it("lands on the oldest day for a date before every restore point", () => {
    expect(dayAtOrBefore(days, new Date(2025, 0, 1))?.key).toBe("2026-09-01");
  });

  it("finds nothing on an empty timeline", () => {
    expect(dayAtOrBefore([], new Date())).toBeNull();
  });
});

describe("localDayKey", () => {
  it("zero-pads month and day", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23))).toBe("2026-01-05");
  });
});
