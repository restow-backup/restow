import type { CalendarOccurrence, EventSummary, ObjectKind } from "@/features/restore/api";
import { isCalendarPath } from "@/features/restore/lib/explorer-search";

/**
 * How the explorer shows a mailbox's calendar: when an event takes place in the viewer's own
 * time (an all-day event by its dates, which belong to no zone), the window of one month, and the
 * days of a month view. Pure, so the order and the wording of dates are tested without a page.
 */

const DAY_MS = 86_400_000;

/** Whether the explorer shows a calendar here: the calendar area of a mailbox. */
export function isCalendarListing(objectKind: ObjectKind, path: string): boolean {
  return objectKind === "mailbox" && isCalendarPath(path);
}

/** `YYYY-MM` of an instant, in the viewer's own time. */
export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The month `delta` months from `month` (`YYYY-MM`). */
export function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split("-").map(Number);
  return monthOf(new Date(year ?? 1970, (number ?? 1) - 1 + delta, 1));
}

/**
 * The window of a month view: from the first to the first of the next month, in the viewer's own
 * time, widened by a day on both sides so all-day events (midnight UTC) of the first and the last
 * day are in, whatever the viewer's zone. {@link occurrencesByDay} keeps to the month itself.
 */
export function monthWindow(month: string): { from: string; to: string } {
  const [year, number] = month.split("-").map(Number);
  const start = new Date(year ?? 1970, (number ?? 1) - 1, 1);
  const end = new Date(year ?? 1970, number ?? 1, 1);
  return {
    from: new Date(start.getTime() - DAY_MS).toISOString(),
    to: new Date(end.getTime() + DAY_MS).toISOString(),
  };
}

/** The month as a heading: "October 2026". */
export function monthLabel(month: string, language: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(language, { month: "long", year: "numeric" }).format(
    new Date(year ?? 1970, (number ?? 1) - 1, 1),
  );
}

/** A day key `YYYY-MM-DD`: an all-day event's own date (UTC), a timed one's in the viewer's time. */
function dayKey(iso: string, allDay: boolean): string {
  const date = new Date(iso);
  if (allDay) {
    return date.toISOString().slice(0, 10);
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  key: string;
  occurrences: CalendarOccurrence[];
}

/**
 * The days of a month that have something on them, in order, each with its occurrences: all-day
 * events first, then by start. An event that lasts several days is shown on its first day.
 */
export function occurrencesByDay(
  occurrences: readonly CalendarOccurrence[],
  month: string,
): CalendarDay[] {
  const days = new Map<string, CalendarOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = dayKey(occurrence.start, occurrence.isAllDay);
    if (!key.startsWith(`${month}-`)) {
      continue;
    }
    const list = days.get(key) ?? [];
    list.push(occurrence);
    days.set(key, list);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, list]) => ({
      key,
      occurrences: [...list].sort(
        (a, b) =>
          Number(b.isAllDay) - Number(a.isAllDay) || Date.parse(a.start) - Date.parse(b.start),
      ),
    }));
}

/** A day heading: "Monday, 14 September". */
export function dayLabel(key: string, language: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(language, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

function formatAllDay(start: string, end: string | null, language: string): string {
  const format = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" });
  const first = new Date(start);
  // The end of an all-day event is the midnight after its last day.
  const last = end ? new Date(Math.max(first.getTime(), Date.parse(end) - DAY_MS)) : first;
  return last.getTime() - first.getTime() >= DAY_MS
    ? format.formatRange(first, last)
    : format.format(first);
}

/**
 * When an event takes place, in one line: "10 Sept 2026, 10:00 – 10:30" (the viewer's own time),
 * "15 Sept 2026" for an all-day event, a range for one over several days; null without a start.
 */
export function eventWhen(
  event: Pick<EventSummary, "start" | "end" | "isAllDay">,
  language: string,
): string | null {
  if (!event.start) {
    return null;
  }
  if (event.isAllDay) {
    return formatAllDay(event.start, event.end, language);
  }
  const start = new Date(event.start);
  const format = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
  if (!event.end) {
    return format.format(start);
  }
  return format.formatRange(start, new Date(Math.max(start.getTime(), Date.parse(event.end))));
}

/** The time of an occurrence in a day of the month view: "10:00 – 10:30". */
export function occurrenceTime(
  occurrence: Pick<CalendarOccurrence, "start" | "end">,
  language: string,
): string {
  const format = new Intl.DateTimeFormat(language, { timeStyle: "short" });
  const start = new Date(occurrence.start);
  return format.formatRange(start, new Date(Math.max(start.getTime(), Date.parse(occurrence.end))));
}

/** The occurrences of a series an expanded row shows: from its start to two years ahead. */
export function seriesWindow(
  event: Pick<EventSummary, "start" | "recurrenceEnd">,
  now: Date = new Date(),
): { from: string; to: string } {
  const start = event.start ? Date.parse(event.start) : now.getTime();
  const horizon = now.getTime() + 2 * 365 * DAY_MS;
  const end = event.recurrenceEnd ? Date.parse(`${event.recurrenceEnd}T23:59:59Z`) + 1000 : horizon;
  const to = Math.max(start + DAY_MS, Math.min(end, horizon));
  // The API takes at most ten years at once; a longer series shows its last ten.
  const from = Math.max(start, to - 3650 * DAY_MS);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
