/**
 * Calendar resources. Events are backed up as Graph JSON: every calendar's
 * single instances and series masters from `/events`, plus the exceptions of each
 * series from `/events/{master}/instances` inside a window (v1.0 has no
 * `exceptionOccurrences` navigation). `calendarView` is for display only and is
 * not used for backup (docs/MICROSOFT.md).
 */
import type { Calendar, Event } from "@microsoft/microsoft-graph-types";
import type { GraphClient } from "../client.js";
import { collect, paginate, query, requestOk, stripReadOnly, userPath } from "./common.js";

export const CALENDAR_SELECT = [
  "id",
  "name",
  "color",
  "hexColor",
  "isDefaultCalendar",
  "canEdit",
  "canShare",
  "canViewPrivateItems",
  "changeKey",
  "owner",
  "isRemovable",
  "defaultOnlineMeetingProvider",
  "allowedOnlineMeetingProviders",
] as const;

export type CalendarInfo = Pick<Calendar, (typeof CALENDAR_SELECT)[number]> & { id: string };

const EVENTS_PAGE_SIZE = 200;

export function listCalendars(
  client: GraphClient,
  userId: string,
): AsyncGenerator<CalendarInfo, void, unknown> {
  const url = `${userPath(userId)}/calendars${query({ $select: CALENDAR_SELECT.join(",") })}`;
  return paginate<CalendarInfo>(client, url);
}

/** Ask for times in UTC so backups are timezone-independent. */
const UTC_PREFER = { Prefer: 'outlook.timezone="UTC"' };

/**
 * Single instances and series masters of a calendar (occurrences and exceptions
 * are not listed by `/events`; see {@link listSeriesExceptions}).
 */
export function listEvents(
  client: GraphClient,
  userId: string,
  calendarId: string,
): AsyncGenerator<Event, void, unknown> {
  const url = `${userPath(userId)}/calendars/${encodeURIComponent(calendarId)}/events${query({
    $top: EVENTS_PAGE_SIZE,
  })}`;
  return paginate<Event>(client, url, UTC_PREFER);
}

export async function getEvent(
  client: GraphClient,
  userId: string,
  eventId: string,
): Promise<Event> {
  return requestOk<Event>(client, {
    method: "GET",
    url: `${userPath(userId)}/events/${encodeURIComponent(eventId)}`,
    headers: UTC_PREFER,
  });
}

export interface InstanceWindow {
  /** ISO 8601 date-time, inclusive. */
  start: string;
  /** ISO 8601 date-time, exclusive. */
  end: string;
}

/** Default: one year back to two years ahead of `now`, clipped to the series range. */
export function defaultInstanceWindow(now: Date = new Date()): InstanceWindow {
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const end = new Date(now);
  end.setUTCFullYear(end.getUTCFullYear() + 2);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Intersect a window with the recurrence range of a series master. */
export function windowForSeries(master: Event, window: InstanceWindow): InstanceWindow | null {
  const range = master.recurrence?.range;
  let start = window.start;
  let end = window.end;
  if (range?.startDate) {
    const rangeStart = `${range.startDate}T00:00:00Z`;
    if (rangeStart > start) {
      start = rangeStart;
    }
  }
  if (range?.type === "endDate" && range.endDate) {
    const rangeEnd = `${range.endDate}T23:59:59Z`;
    if (rangeEnd < end) {
      end = rangeEnd;
    }
  }
  return start < end ? { start, end } : null;
}

/**
 * The modified occurrences (type `exception`) of a series master in the window.
 * Deleted occurrences do not appear; they are absent from the instances list.
 */
export async function listSeriesExceptions(
  client: GraphClient,
  userId: string,
  master: Event & { id: string },
  window: InstanceWindow = defaultInstanceWindow(),
): Promise<Event[]> {
  const effective = windowForSeries(master, window);
  if (!effective) {
    return [];
  }
  const url = `${userPath(userId)}/events/${encodeURIComponent(master.id)}/instances${query({
    startDateTime: effective.start,
    endDateTime: effective.end,
    $top: EVENTS_PAGE_SIZE,
  })}`;
  const instances = await collect(paginate<Event>(client, url, UTC_PREFER));
  return instances.filter((instance) => instance.type === "exception");
}

export interface CalendarBackupItem {
  event: Event;
  /** Exceptions of a series master; empty for single instances. */
  exceptions: Event[];
}

/** All events of a calendar with their exceptions, ready to be stored as JSON. */
export async function* listCalendarBackupItems(
  client: GraphClient,
  userId: string,
  calendarId: string,
  window: InstanceWindow = defaultInstanceWindow(),
): AsyncGenerator<CalendarBackupItem, void, unknown> {
  for await (const event of listEvents(client, userId, calendarId)) {
    if (event.type === "seriesMaster" && event.id) {
      yield {
        event,
        exceptions: await listSeriesExceptions(
          client,
          userId,
          event as Event & { id: string },
          window,
        ),
      };
    } else {
      yield { event, exceptions: [] };
    }
  }
}

/** Properties Graph rejects or regenerates when an event is created. */
const EVENT_READ_ONLY = [
  "id",
  "changeKey",
  "createdDateTime",
  "lastModifiedDateTime",
  "iCalUId",
  "uid",
  "webLink",
  "onlineMeeting",
  "onlineMeetingUrl",
  "seriesMasterId",
  "occurrenceId",
  "originalStart",
  "type",
  "hasAttachments",
  "bodyPreview",
  "isCancelled",
  "isOrganizer",
  "isDraft",
  "responseStatus",
  "organizer",
  "calendar",
  "instances",
  "attachments",
  "extensions",
  "multiValueExtendedProperties",
  "singleValueExtendedProperties",
  "cancelledOccurrences",
  "exceptionOccurrences",
] as const;

/**
 * Strip read-only properties for a POST. Creating an event with attendees makes
 * Exchange send invitations, which a restore must not do silently, so attendees
 * are dropped unless `keepAttendees` is set; the original attendee list stays in
 * the backed-up JSON and is shown to the user.
 */
export function toCreatableEvent(
  event: Event,
  options: { keepAttendees?: boolean } = {},
): Partial<Event> {
  const readOnly = options.keepAttendees ? EVENT_READ_ONLY : [...EVENT_READ_ONLY, "attendees"];
  return stripReadOnly(event as Record<string, unknown>, readOnly) as Partial<Event>;
}

export async function createEvent(
  client: GraphClient,
  userId: string,
  calendarId: string,
  event: Partial<Event>,
): Promise<Event> {
  return requestOk<Event>(client, {
    method: "POST",
    url: `${userPath(userId)}/calendars/${encodeURIComponent(calendarId)}/events`,
    headers: UTC_PREFER,
    body: event,
  });
}

export async function updateEvent(
  client: GraphClient,
  userId: string,
  eventId: string,
  patch: Partial<Event>,
): Promise<Event> {
  return requestOk<Event>(client, {
    method: "PATCH",
    url: `${userPath(userId)}/events/${encodeURIComponent(eventId)}`,
    headers: UTC_PREFER,
    body: patch,
  });
}

/**
 * Find the occurrence of a restored series that corresponds to a backed-up
 * exception (by `originalStart`), so the exception's changes can be re-applied
 * with {@link updateEvent}.
 */
export async function findOccurrenceByOriginalStart(
  client: GraphClient,
  userId: string,
  masterId: string,
  originalStart: string,
): Promise<Event | null> {
  const startMs = Date.parse(originalStart);
  if (Number.isNaN(startMs)) {
    return null;
  }
  const start = new Date(startMs - 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(startMs + 24 * 60 * 60 * 1000).toISOString();
  const url = `${userPath(userId)}/events/${encodeURIComponent(masterId)}/instances${query({
    startDateTime: start,
    endDateTime: end,
    $top: 50,
  })}`;
  for await (const instance of paginate<Event>(client, url, UTC_PREFER)) {
    const candidate = instance.originalStart ?? instance.start?.dateTime;
    if (candidate && sameInstant(candidate, originalStart)) {
      return instance;
    }
  }
  return null;
}

/** Compare two ISO timestamps as instants; Graph pads fractional seconds to 7 digits. */
export function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a.endsWith("Z") || /[+-]\d\d:\d\d$/.test(a) ? a : `${a}Z`);
  const right = Date.parse(b.endsWith("Z") || /[+-]\d\d:\d\d$/.test(b) ? b : `${b}Z`);
  return !Number.isNaN(left) && left === right;
}

/** Create a calendar (for restores into a fresh calendar next to the original). */
export async function createCalendar(
  client: GraphClient,
  userId: string,
  name: string,
): Promise<CalendarInfo> {
  return requestOk<CalendarInfo>(client, {
    method: "POST",
    url: `${userPath(userId)}/calendars`,
    body: { name },
  });
}

/** The user's default calendar. */
export async function getDefaultCalendar(
  client: GraphClient,
  userId: string,
): Promise<CalendarInfo> {
  return requestOk<CalendarInfo>(client, {
    method: "GET",
    url: `${userPath(userId)}/calendar${query({ $select: CALENDAR_SELECT.join(",") })}`,
  });
}
