// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { CalendarOccurrence, TreeEntry } from "../api.js";
import { CalendarMonth, SeriesOccurrences } from "./calendar-view.js";

/**
 * The calendar of a restore point: a month day by day with every series expanded, the way to the
 * months around it, and the occurrences of one series under its row; a click opens the event.
 */

enableActEnvironment();

let mounted: Mounted | null = null;
const asked: URL[] = [];

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  asked.length = 0;
  vi.unstubAllGlobals();
});

const SESSION = sessionAs({
  role: "tenant_admin",
  isProviderAdmin: false,
  activeTenant: {
    id: "t1",
    name: "Müller GmbH",
    slug: "mueller",
    kind: "customer",
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
  },
});

function occurrence(over: Partial<CalendarOccurrence>): CalendarOccurrence {
  return {
    entryId: "11111111-1111-4111-8111-111111111111",
    entryPath: "calendar/Calendar/Weekly sync.0123456789abcdef.json",
    entryName: "Weekly sync.0123456789abcdef.json",
    itemId: "evt-master",
    size: 900,
    calendarName: "Calendar",
    kind: "occurrence",
    subject: "Weekly sync",
    start: "2026-09-07T10:00:00.000Z",
    end: "2026-09-07T10:30:00.000Z",
    isAllDay: false,
    location: "Room 1",
    organizer: "anna@example.test",
    isCancelled: false,
    ...over,
  };
}

const SEPTEMBER = [
  occurrence({}),
  occurrence({
    entryId: "22222222-2222-4222-8222-222222222222",
    entryPath: "calendar/Calendar/Dentist.aaaaaaaaaaaaaaaa.json",
    entryName: "Dentist.aaaaaaaaaaaaaaaa.json",
    kind: "single",
    subject: "Dentist",
    start: "2026-09-10T08:00:00.000Z",
    end: "2026-09-10T09:00:00.000Z",
    location: "Praxis Dr. Weber",
  }),
  occurrence({
    kind: "exception",
    subject: "Weekly sync (moved)",
    start: "2026-09-14T14:00:00.000Z",
    end: "2026-09-14T14:30:00.000Z",
  }),
  occurrence({
    entryId: "33333333-3333-4333-8333-333333333333",
    entryPath: "calendar/Team/Holiday.bbbbbbbbbbbbbbbb.json",
    entryName: "Holiday.bbbbbbbbbbbbbbbb.json",
    calendarName: "Team",
    kind: "single",
    subject: "Holiday",
    start: "2026-09-15T00:00:00.000Z",
    end: "2026-09-16T00:00:00.000Z",
    isAllDay: true,
    location: null,
  }),
];

function stubCalendar(occurrences: CalendarOccurrence[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    asked.push(url);
    if (!url.pathname.endsWith("/calendar")) {
      throw new Error(`Unrouted request: ${url.pathname}`);
    }
    return json({
      snapshotId: "s1",
      path: url.searchParams.get("path"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      occurrences,
      truncated: false,
      unexpandedSeries: 0,
    });
  });
}

const slots = (name: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

describe("the month view", () => {
  it("lists the days of the month with their appointments, all-day first, from every calendar", async () => {
    stubCalendar(SEPTEMBER);
    const onOpen = vi.fn();
    const onMonthChange = vi.fn();
    mounted = mount(
      <CalendarMonth
        snapshotId="s1"
        path="calendar"
        month="2026-09"
        activePath={null}
        onMonthChange={onMonthChange}
        onOpen={onOpen}
      />,
      { session: SESSION },
    );
    await flush(6);
    expect(document.body.textContent).toContain("September 2026");
    expect(asked[0]?.searchParams.get("path")).toBe("calendar");
    const days = slots("calendar-day");
    expect(days.map((day) => day.querySelector("h4")?.textContent)).toEqual([
      "Monday, September 7",
      "Thursday, September 10",
      "Monday, September 14",
      "Tuesday, September 15",
    ]);
    expect(days[3]?.textContent).toContain("All day");
    expect(days[3]?.textContent).toContain("Team");
    expect(days[2]?.querySelector('[aria-label="Changed occurrence of a series"]')).not.toBeNull();

    const dentist = slots("calendar-occurrence").find((node) =>
      node.textContent?.includes("Dentist"),
    );
    await act(async () => dentist?.click());
    const opened = onOpen.mock.calls[0]?.[0] as TreeEntry;
    expect(opened).toMatchObject({
      kind: "event",
      path: "calendar/Calendar/Dentist.aaaaaaaaaaaaaaaa.json",
      parentPath: "calendar/Calendar",
    });

    const next = document.querySelector<HTMLButtonElement>('[aria-label="Next month"]');
    await act(async () => next?.click());
    expect(onMonthChange).toHaveBeenCalledWith("2026-10");
  });

  it("says so when the month has nothing on it", async () => {
    stubCalendar([]);
    mounted = mount(
      <CalendarMonth
        snapshotId="s1"
        path="calendar/Team"
        month="2026-02"
        activePath={null}
        onMonthChange={() => {}}
        onOpen={() => {}}
      />,
      { session: SESSION },
    );
    await flush(6);
    expect(document.body.textContent).toContain("Nothing on this month");
  });
});

describe("the occurrences of a series", () => {
  it("asks for that one series from its start to its end and lists every occurrence", async () => {
    stubCalendar([SEPTEMBER[0] as CalendarOccurrence, SEPTEMBER[2] as CalendarOccurrence]);
    const entry: TreeEntry = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "event",
      name: "Weekly sync.0123456789abcdef.json",
      path: "calendar/Calendar/Weekly sync.0123456789abcdef.json",
      parentPath: "calendar/Calendar",
      size: 900,
      mtime: null,
      itemId: "evt-master",
      deleted: false,
      implicit: false,
      mail: null,
      contentType: "application/json",
      event: {
        subject: "Weekly sync",
        start: "2026-01-05T10:00:00.000Z",
        end: "2026-01-05T10:30:00.000Z",
        isAllDay: false,
        type: "seriesMaster",
        recurring: true,
        organizer: null,
        location: "Room 1",
        isCancelled: false,
        exceptionCount: 1,
        calendarName: "Calendar",
        recurrenceEnd: "2026-12-28",
      },
    };
    mounted = mount(<SeriesOccurrences snapshotId="s1" entry={entry} onOpen={() => {}} />, {
      session: SESSION,
    });
    await flush(6);
    const url = asked[0];
    expect(url?.searchParams.get("entryId")).toBe(entry.id);
    expect(url?.searchParams.get("path")).toBe("calendar/Calendar");
    expect(url?.searchParams.get("from")).toBe("2026-01-05T10:00:00.000Z");
    expect(url?.searchParams.get("to")).toBe("2026-12-29T00:00:00.000Z");
    const list = slots("series-occurrences")[0];
    expect(list?.textContent).toContain("2 occurrences");
    expect(list?.textContent).toContain("Weekly sync (moved)");
    expect(list?.textContent).toContain("Changed");
  });
});
