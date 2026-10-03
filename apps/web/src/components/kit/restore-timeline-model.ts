import { toDate } from "./relative-time.js";

/**
 * The pure part of the restore point timeline (restore-timeline.tsx): restore
 * points grouped by the local calendar day they were taken on, newest day and
 * newest time first, and the day a "jump to date" lands on. Nothing here
 * touches the DOM, so every rule is unit tested.
 */

/** One calendar day of the timeline with its restore points, newest first. */
export interface TimelineDay<T> {
  /** The local day as `YYYY-MM-DD`; stable, sortable and usable as a DOM id. */
  key: string;
  /** Local midnight of that day. */
  date: Date;
  items: T[];
}

/** How a day separator reads: "Today", "Yesterday" or the weekday and date. */
export type DayRelation = "today" | "yesterday" | "other";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The local calendar day of `date` as `YYYY-MM-DD`. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Groups `items` by the local day of `timeOf(item)`: the newest day first and,
 * within a day, the newest restore point first, whatever order they came in.
 * Items without a readable time cannot sit on a timeline and are left out.
 */
export function groupByLocalDay<T>(
  items: readonly T[],
  timeOf: (item: T) => string | null | undefined,
): TimelineDay<T>[] {
  const timed = items
    .map((item) => ({ item, date: toDate(timeOf(item)) }))
    .filter((entry): entry is { item: T; date: Date } => entry.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const days: TimelineDay<T>[] = [];
  for (const { item, date } of timed) {
    const key = localDayKey(date);
    const last = days[days.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      days.push({ key, date: startOfLocalDay(date), items: [item] });
    }
  }
  return days;
}

/** Whether `day` is today, yesterday or any other day, seen from `now`. */
export function dayRelation(day: Date, now: Date = new Date()): DayRelation {
  const key = localDayKey(day);
  if (key === localDayKey(now)) {
    return "today";
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return key === localDayKey(yesterday) ? "yesterday" : "other";
}

/**
 * The day a jump to `target` lands on: that day itself when it has restore
 * points, otherwise the nearest earlier day that has some (what the data
 * looked like on that date). A date before the oldest restore point lands on
 * the oldest day, since there is nothing earlier to show. `days` must be in
 * timeline order (newest first); `null` only for an empty timeline.
 */
export function dayAtOrBefore<T>(
  days: readonly TimelineDay<T>[],
  target: Date,
): TimelineDay<T> | null {
  const wanted = localDayKey(target);
  // `YYYY-MM-DD` keys compare like the days they stand for.
  return days.find((day) => day.key <= wanted) ?? days[days.length - 1] ?? null;
}
