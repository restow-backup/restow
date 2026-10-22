/**
 * Calendar resources. Events are backed up as Graph JSON: every calendar's
 * single instances and series masters from `/events`, plus the exceptions of each
 * series from `/events/{master}/instances` inside a window (v1.0 has no
 * `exceptionOccurrences` navigation). `calendarView` is for display only and is
 * not used for a user's backup (docs/MICROSOFT.md).
 *
 * Every function takes a {@link MailboxOwner}: a user (id or UPN) or the
 * mailbox of a Microsoft 365 group. A group mailbox has exactly one calendar,
 * addressed as `/groups/{id}/calendar` instead of `/calendars/{id}`; it is
 * represented by {@link GROUP_CALENDAR} so callers need no special case. Graph
 * v1.0 documents the group `events` listing as delegated only, while the
 * group `calendarView` accepts application permissions; a refused listing
 * falls back to it ({@link listGroupCalendarEvents}).
 */
import type { Calendar, Event } from "@microsoft/microsoft-graph-types";
import type { GraphClient } from "../client.js";
import { isGraphError, isNotFound } from "../errors.js";
import {
  collect,
  isGroupOwner,
  type MailboxOwner,
  ownerPath,
  paginate,
  query,
  requestOk,
  stripReadOnly,
} from "./common.js";

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

/**
 * The one calendar of a group mailbox. Its id is a fixed name rather than the
 * Graph id: reading `/groups/{id}/calendar` is documented as delegated only,
 * and a stable id keeps the backed-up events' grouping stable either way.
 */
export const GROUP_CALENDAR: CalendarInfo = {
  id: "group-calendar",
  name: "Calendar",
  isDefaultCalendar: true,
  canEdit: true,
};

/** The URL of a calendar: `/calendars/{id}` of a user, the group's only `/calendar`. */
export function calendarPath(owner: MailboxOwner, calendarId: string): string {
  return isGroupOwner(owner)
    ? `${ownerPath(owner)}/calendar`
    : `${ownerPath(owner)}/calendars/${encodeURIComponent(calendarId)}`;
}

export async function* listCalendars(
  client: GraphClient,
  owner: MailboxOwner,
): AsyncGenerator<CalendarInfo, void, unknown> {
  if (isGroupOwner(owner)) {
    yield GROUP_CALENDAR;
    return;
  }
  const url = `${ownerPath(owner)}/calendars${query({ $select: CALENDAR_SELECT.join(",") })}`;
  yield* paginate<CalendarInfo>(client, url);
}

/** Ask for times in UTC so backups are timezone-independent. */
const UTC_PREFER = { Prefer: 'outlook.timezone="UTC"' };

/**
 * Single instances and series masters of a calendar (occurrences and exceptions
 * are not listed by `/events`; see {@link listSeriesExceptions}).
 */
export function listEvents(
  client: GraphClient,
  owner: MailboxOwner,
  calendarId: string,
): AsyncGenerator<Event, void, unknown> {
  const url = `${calendarPath(owner, calendarId)}/events${query({
    $top: EVENTS_PAGE_SIZE,
  })}`;
  return paginate<Event>(client, url, UTC_PREFER);
}

export async function getEvent(
  client: GraphClient,
  owner: MailboxOwner,
  eventId: string,
): Promise<Event> {
  return requestOk<Event>(client, {
    method: "GET",
    url: `${ownerPath(owner)}/events/${encodeURIComponent(eventId)}`,
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
  owner: MailboxOwner,
  master: Event & { id: string },
  window: InstanceWindow = defaultInstanceWindow(),
): Promise<Event[]> {
  const effective = windowForSeries(master, window);
  if (!effective) {
    return [];
  }
  const url = `${ownerPath(owner)}/events/${encodeURIComponent(master.id)}/instances${query({
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
  owner: MailboxOwner,
  calendarId: string,
  window: InstanceWindow = defaultInstanceWindow(),
): AsyncGenerator<CalendarBackupItem, void, unknown> {
  for await (const event of listEvents(client, owner, calendarId)) {
    if (event.type === "seriesMaster" && event.id) {
      yield {
        event,
        exceptions: await listSeriesExceptions(
          client,
          owner,
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
  owner: MailboxOwner,
  calendarId: string,
  event: Partial<Event>,
): Promise<Event> {
  return requestOk<Event>(client, {
    method: "POST",
    url: `${calendarPath(owner, calendarId)}/events`,
    headers: UTC_PREFER,
    body: event,
  });
}

export async function updateEvent(
  client: GraphClient,
  owner: MailboxOwner,
  eventId: string,
  patch: Partial<Event>,
): Promise<Event> {
  return requestOk<Event>(client, {
    method: "PATCH",
    url: `${ownerPath(owner)}/events/${encodeURIComponent(eventId)}`,
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
  owner: MailboxOwner,
  masterId: string,
  originalStart: string,
): Promise<Event | null> {
  const startMs = Date.parse(originalStart);
  if (Number.isNaN(startMs)) {
    return null;
  }
  const start = new Date(startMs - 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(startMs + 24 * 60 * 60 * 1000).toISOString();
  const url = `${ownerPath(owner)}/events/${encodeURIComponent(masterId)}/instances${query({
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
  owner: MailboxOwner,
  name: string,
): Promise<CalendarInfo> {
  if (isGroupOwner(owner)) {
    throw new Error("a Microsoft 365 group has exactly one calendar; no other can be created");
  }
  return requestOk<CalendarInfo>(client, {
    method: "POST",
    url: `${ownerPath(owner)}/calendars`,
    body: { name },
  });
}

/** The user's default calendar; a group's only one. */
export async function getDefaultCalendar(
  client: GraphClient,
  owner: MailboxOwner,
): Promise<CalendarInfo> {
  if (isGroupOwner(owner)) {
    return GROUP_CALENDAR;
  }
  return requestOk<CalendarInfo>(client, {
    method: "GET",
    url: `${ownerPath(owner)}/calendar${query({ $select: CALENDAR_SELECT.join(",") })}`,
  });
}

/**
 * Graph refused a group calendar request for the app (401/403, or a 400
 * that says application permissions are not supported): the answer that
 * switches {@link listGroupCalendarEvents} to `calendarView`, and that the
 * backup reports as a warning instead of failing the run.
 */
export function isGroupCalendarRefusal(error: unknown): boolean {
  if (!isGraphError(error)) {
    return false;
  }
  if (error.status === 401 || error.status === 403) {
    return true;
  }
  return (
    error.status === 400 &&
    /not\s*supported|access\s*denied|unauthori[sz]ed/i.test(
      `${error.code ?? ""} ${error.innerCode ?? ""} ${error.message}`,
    )
  );
}

/**
 * How far back the `calendarView` fallback reaches. The view needs a range;
 * single events before it are not seen by the fallback (docs/MICROSOFT.md,
 * group calendars).
 */
export const GROUP_CALENDAR_VIEW_YEARS_BACK = 5;

/** The window of the `calendarView` fallback: five years back to the end of `window`. */
export function groupCalendarViewWindow(window: InstanceWindow, now: Date): InstanceWindow {
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - GROUP_CALENDAR_VIEW_YEARS_BACK);
  const iso = start.toISOString();
  return { start: iso < window.start ? iso : window.start, end: window.end };
}

/**
 * The single events and series masters of a group calendar, as
 * {@link listEvents} lists them for a user. `/groups/{id}/calendar/events` is
 * tried first; when Graph refuses it for application permissions, the
 * events are reconstructed from `/groups/{id}/calendarView` over `viewWindow`:
 * single instances as they are, and per series its master, read once by the
 * `seriesMasterId` of the first occurrence seen (exceptions are then fetched
 * from the master as usual). A master Graph will not hand out either leaves
 * that series' occurrences in the window as single events, flagged by their
 * `type` (`occurrence`, `exception`), so they are at least restorable as
 * appointments. Bounded memory: one entry per series id.
 */
export async function* listGroupCalendarEvents(
  client: GraphClient,
  groupId: string,
  viewWindow: InstanceWindow,
  onFallback?: (error: unknown) => void,
): AsyncGenerator<Event, void, unknown> {
  const owner = { groupId };
  let listed = false;
  try {
    for await (const event of listEvents(client, owner, GROUP_CALENDAR.id)) {
      listed = true;
      yield event;
    }
    return;
  } catch (error) {
    if (listed || !isGroupCalendarRefusal(error)) {
      throw error;
    }
    onFallback?.(error);
  }
  const url = `${ownerPath(owner)}/calendarView${query({
    startDateTime: viewWindow.start,
    endDateTime: viewWindow.end,
    $top: EVENTS_PAGE_SIZE,
  })}`;
  /** Series master id -> whether its master could be read (and was yielded). */
  const masters = new Map<string, boolean>();
  for await (const instance of paginate<Event>(client, url, UTC_PREFER)) {
    const masterId = instance.seriesMasterId;
    if (instance.type === "singleInstance" || !masterId) {
      yield instance;
      continue;
    }
    let readable = masters.get(masterId);
    if (readable === undefined) {
      let master: Event | null = null;
      try {
        master = await getEvent(client, owner, masterId);
      } catch (error) {
        if (!isGroupCalendarRefusal(error) && !isNotFound(error)) {
          throw error;
        }
      }
      readable = master !== null;
      masters.set(masterId, readable);
      if (master) {
        yield master;
      }
    }
    if (!readable) {
      yield instance;
    }
  }
}
