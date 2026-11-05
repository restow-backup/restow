/**
 * Calendar phase: every calendar of the mailbox, its single instances and
 * series masters as Graph JSON, each master bundled with the exceptions of its
 * series inside the backup window (docs/MICROSOFT.md: masters plus exceptions,
 * never `calendarView`). Calendars have no delta in v1.0, so each run lists
 * them fully; unchanged events are recognised by their bytes and cost nothing.
 *
 * Attachments of a user calendar's event (not part of the event JSON) are
 * backed up as `event-attachment` objects below the event
 * (`<event>.attachments/<name>.<id>`): a file attachment's bytes, an item
 * attachment's Graph JSON, a link attachment's name on the event. They are
 * listed again when the event's changeKey moved; a failed attachment is an
 * item failure, never a silent gap. Group calendars do not hand attachments
 * to the app: a run whose group calendar has events with attachments says so
 * in one warning.
 *
 * The same phase backs up the one calendar of a Microsoft 365 group mailbox
 * (`run.owner` is the group): its events are listed with
 * {@link listGroupCalendarEvents}, which falls back to the group's
 * `calendarView` when Graph refuses the plain listing to the app. A group
 * calendar the app may not read at all is one item failure (a warning with
 * the reason), never a failed run: the group's conversations are still
 * backed up.
 */
import type { Event } from "@microsoft/microsoft-graph-types";
import { buildCause } from "../../failures/classify.js";
import { isGraphError } from "../../graph/errors.js";
import {
  type CalendarInfo,
  eventPath as eventUrl,
  getEventItemAttachment,
  groupCalendarViewWindow,
  type InstanceWindow,
  isGroupCalendarRefusal,
  listCalendars,
  listEvents,
  listGroupCalendarEvents,
  listSeriesExceptions,
} from "../../graph/resources/calendar.js";
import { collect, isGroupOwner } from "../../graph/resources/common.js";
import {
  type AttachmentMeta,
  listAttachmentsWithContentIdAt,
  openAttachmentContentAt,
} from "../../graph/resources/mail.js";
import type { ManifestObject } from "../../manifest.js";
import {
  folderObjectAt,
  reconcileGroupFolders,
  removeGroupItems,
  removeUnseenItems,
  storeJsonItem,
} from "./folders.js";
import {
  assignFolderPaths,
  attachmentObjectPath,
  attachmentsFolderOf,
  CALENDAR_ROOT,
  displayFolderPath,
  eventObjectPath,
  rebasePath,
} from "./paths.js";
import {
  type BackupRun,
  calendarGroup,
  describeError,
  type FetchedObject,
  ItemError,
  isAreaRefused,
  isItemLevelError,
  isVanished,
  META,
  OBJECT_TYPES,
  toMailboxAccessError,
} from "./run.js";
import { toMillis } from "./time.js";

export const FOLDER_KIND_CALENDAR = "calendar";

export interface CalendarPhaseOptions {
  readonly window: InstanceWindow;
  /**
   * Group calendars only: the range the `calendarView` fallback reads when
   * Graph refuses the plain event listing; defaults to
   * {@link groupCalendarViewWindow}.
   */
  readonly viewWindow?: InstanceWindow;
}

/** The stored payload of one event object. */
export interface StoredEvent {
  readonly event: Event;
  /** Modified occurrences of a series master inside the window; empty otherwise. */
  readonly exceptions: Event[];
}

interface PlannedCalendar {
  readonly calendar: CalendarInfo;
  /** Object path, e.g. `calendar/Team`. */
  readonly path: string;
  /** The calendar's name as the `folderPath` of its events. */
  readonly displayPath: string;
}

/** Metadata every event of a calendar carries (and gets again when the calendar is renamed). */
function calendarLocation(planned: PlannedCalendar): Record<string, string> {
  return {
    [META.calendarId]: planned.calendar.id,
    [META.calendarName]: planned.calendar.name ?? "",
    [META.isDefaultCalendar]: String(planned.calendar.isDefaultCalendar === true),
    [META.folderPath]: planned.displayPath,
  };
}

function calendarFolderObject(planned: PlannedCalendar) {
  const { calendar } = planned;
  return folderObjectAt(planned.path, calendar.id, {
    ...calendarLocation(planned),
    [META.folderKind]: FOLDER_KIND_CALENDAR,
    color: calendar.color ?? "",
    hexColor: calendar.hexColor ?? "",
    owner: calendar.owner?.address ?? "",
    canEdit: String(calendar.canEdit === true),
  });
}

/**
 * What the restore explorer lists an event by without opening it: subject, start and end (UTC),
 * all day or not, where, who organised it, and for a series master the last day of its range
 * (empty without an end), so a month view only opens the series that can fall into it.
 */
export function eventMetadata(
  event: Event,
  location: Record<string, string>,
  exceptionCount: number,
): Record<string, string> {
  const range = event.recurrence?.range;
  return {
    ...location,
    subject: event.subject ?? "",
    eventType: event.type ?? "",
    start: event.start?.dateTime ?? "",
    end: event.end?.dateTime ?? "",
    isAllDay: String(event.isAllDay === true),
    isCancelled: String(event.isCancelled === true),
    organizer: event.organizer?.emailAddress?.address ?? "",
    iCalUId: event.iCalUId ?? "",
    changeKey: event.changeKey ?? "",
    lastModifiedDateTime: event.lastModifiedDateTime ?? "",
    hasAttachments: String(event.hasAttachments === true),
    exceptionCount: String(exceptionCount),
    location: event.location?.displayName ?? "",
    recurrenceEnd: range?.type === "endDate" ? (range.endDate ?? "") : "",
  };
}

/** Event metadata written by the attachment step, carried with the event until it runs again. */
const EVENT_ATTACHMENT_METADATA = [
  META.attachmentsChangeKey,
  META.attachmentCount,
  META.referenceAttachments,
  META.contentIdUnavailable,
] as const;

async function storeEvent(
  run: BackupRun,
  planned: PlannedCalendar,
  event: Event & { id: string },
  options: CalendarPhaseOptions,
): Promise<void> {
  const exceptions =
    event.type === "seriesMaster"
      ? await listSeriesExceptions(run.client, run.owner, event, options.window)
      : [];
  const payload: StoredEvent = { event, exceptions };
  const metadata = eventMetadata(event, calendarLocation(planned), exceptions.length);
  const existing = run.index.get(OBJECT_TYPES.event, event.id);
  for (const key of EVENT_ATTACHMENT_METADATA) {
    const value = existing?.metadata?.[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  const path = eventObjectPath(planned.path, event.subject, event.id);
  await storeJsonItem(run, {
    type: OBJECT_TYPES.event,
    id: event.id,
    path,
    mtime: toMillis(event.lastModifiedDateTime) || toMillis(event.createdDateTime),
    metadata,
    payload,
  });
  if (!isGroupOwner(run.owner)) {
    await syncEventAttachments(run, planned, event, path);
  }
}

const FOLDER_KIND_ATTACHMENTS = "attachments";
const REFERENCE_ATTACHMENT = "#microsoft.graph.referenceAttachment";
const ITEM_ATTACHMENT = "#microsoft.graph.itemAttachment";

/** Failure reason when an attachment 404s while its event still exists (no user content). */
const EVENT_ATTACHMENT_REMOVED =
  "an attachment was removed from the event while it was being backed up";

/** The attachment objects (and their folder) stored for an event. */
function eventRiders(run: BackupRun, calendarId: string, eventId: string): ManifestObject[] {
  return run.index
    .members(calendarGroup(calendarId))
    .filter((member) => member.metadata?.[META.eventItemId] === eventId);
}

/**
 * Bring the stored attachments of a user calendar's event in line with the event. Unchanged
 * changeKey: they stay (re-pathed when the event was renamed). Otherwise every attachment is
 * read again and the set replaces the stored one in one step; any attachment that cannot be
 * read fails the event's attachments as an item failure and keeps the stored ones, so the next
 * run tries again.
 */
async function syncEventAttachments(
  run: BackupRun,
  planned: PlannedCalendar,
  event: Event & { id: string },
  path: string,
): Promise<void> {
  const calendarId = planned.calendar.id;
  const stored = eventRiders(run, calendarId, event.id);
  const eventObject = run.index.get(OBJECT_TYPES.event, event.id);
  if (!eventObject) {
    return;
  }
  const folder = attachmentsFolderOf(path);
  if (event.hasAttachments !== true) {
    for (const rider of stored) {
      run.index.removePath(rider.path);
    }
    putEventMetadata(run, eventObject, {});
    return;
  }
  const changeKey = event.changeKey ?? event.lastModifiedDateTime ?? "";
  const current =
    eventObject.metadata?.[META.attachmentsChangeKey] === changeKey &&
    (!run.full || stored.every((rider) => run.fetchedInThisRun(rider)));
  if (current) {
    repathRiders(run, stored, folder, path);
    return;
  }

  const parent = eventUrl(run.owner, event.id);
  const listed = await listAttachmentsWithContentIdAt(run.client, parent);
  const location = calendarLocation(planned);
  const objects: FetchedObject[] = [];
  const references: string[] = [];
  for (const meta of listed.attachments) {
    run.throwIfAborted();
    const type = meta["@odata.type"] ?? "#microsoft.graph.fileAttachment";
    if (type === REFERENCE_ATTACHMENT) {
      references.push(meta.name ?? "");
      continue;
    }
    let content: FetchedObject["content"];
    try {
      content =
        type === ITEM_ATTACHMENT
          ? await run.writeContent(
              Buffer.from(
                JSON.stringify(
                  await getEventItemAttachment(run.client, run.owner, event.id, meta.id),
                ),
                "utf8",
              ),
            )
          : await run.writeContent(await openAttachmentContentAt(run.client, parent, meta.id));
    } catch (error) {
      throw isVanished(error) ? new ItemError(EVENT_ATTACHMENT_REMOVED, { cause: error }) : error;
    }
    objects.push({
      object: {
        path: attachmentObjectPath(folder, meta.name, meta.id),
        id: `${event.id}/${meta.id}`,
        type: OBJECT_TYPES.eventAttachment,
        mtime: toMillis(meta.lastModifiedDateTime) || eventObject.mtime,
        metadata: eventAttachmentMetadata(meta, type, location, event.id, path),
      },
      content,
    });
  }

  for (const rider of stored) {
    run.index.removePath(rider.path);
  }
  if (objects.length > 0) {
    run.index.put({
      path: folder,
      id: `${event.id}/attachments`,
      type: OBJECT_TYPES.folder,
      size: 0,
      mtime: 0,
      chunks: [],
      metadata: {
        ...location,
        [META.folderKind]: FOLDER_KIND_ATTACHMENTS,
        [META.eventItemId]: event.id,
        [META.eventPath]: path,
      },
    });
    run.recordRiders(objects);
  }
  const update: Record<string, string> = {
    [META.attachmentsChangeKey]: changeKey,
    [META.attachmentCount]: String(objects.length),
  };
  if (references.length > 0) {
    update[META.referenceAttachments] = JSON.stringify(references);
  }
  if (listed.contentIdUnavailable) {
    update[META.contentIdUnavailable] = "true";
  }
  putEventMetadata(run, eventObject, update);
}

function eventAttachmentMetadata(
  meta: AttachmentMeta,
  type: string,
  location: Record<string, string>,
  eventId: string,
  eventObjectPathValue: string,
): Record<string, string> {
  const metadata: Record<string, string> = {
    ...location,
    [META.eventItemId]: eventId,
    [META.eventPath]: eventObjectPathValue,
    [META.name]: meta.name ?? "",
    [META.contentType]:
      type === ITEM_ATTACHMENT
        ? "application/json"
        : (meta.contentType ?? "application/octet-stream"),
    [META.isInline]: String(meta.isInline === true),
    attachmentType: type,
    declaredSize: String(meta.size ?? ""),
  };
  if (typeof meta.contentId === "string" && meta.contentId.trim().length > 0) {
    metadata[META.contentId] = meta.contentId;
  }
  return metadata;
}

/** Replace the attachment facts on the stored event (without touching its bytes). */
function putEventMetadata(
  run: BackupRun,
  eventObject: ManifestObject,
  update: Record<string, string>,
): void {
  const metadata = { ...(eventObject.metadata ?? {}) };
  for (const key of EVENT_ATTACHMENT_METADATA) {
    delete metadata[key];
  }
  Object.assign(metadata, update);
  const before = eventObject.metadata ?? {};
  const same =
    Object.keys(metadata).length === Object.keys(before).length &&
    Object.entries(metadata).every(([key, value]) => before[key] === value);
  if (!same) {
    run.index.put({ ...eventObject, metadata });
  }
}

/** A renamed event (or calendar) takes its stored attachments and their folder along. */
function repathRiders(
  run: BackupRun,
  riders: readonly ManifestObject[],
  folder: string,
  path: string,
): void {
  const from = riders.find((rider) => rider.type === OBJECT_TYPES.folder)?.path ?? folder;
  const moved = riders.map((rider) => ({
    rider,
    next: {
      ...rider,
      path: from === folder ? rider.path : rebasePath(rider.path, from, folder),
      metadata: { ...(rider.metadata ?? {}), [META.eventPath]: path },
    },
  }));
  const changed = moved.filter(
    ({ rider, next }) => rider.path !== next.path || rider.metadata?.[META.eventPath] !== path,
  );
  for (const { rider } of changed) {
    run.index.removePath(rider.path);
  }
  for (const { next } of changed) {
    run.index.put(next);
  }
}

/** The UTC instant of a stored event's `start` (Graph's dateTime without zone, asked in UTC). */
function storedStart(object: ManifestObject): number | null {
  const start = object.metadata?.start ?? "";
  if (start === "") {
    return null;
  }
  const instant = Date.parse(/(z|[+-]\d\d:?\d\d)$/i.test(start) ? start : `${start}Z`);
  return Number.isNaN(instant) ? null : instant;
}

/**
 * {@link removeUnseenItems} limited to what the view would have listed: a stored event whose
 * start lies inside the window, and a series master only when its whole range does and the
 * view listed none of its occurrences (an unreadable master leaves them as single events).
 */
function removeUnseenInWindow(
  run: BackupRun,
  planned: PlannedCalendar,
  seen: Set<string>,
  scope: ListingScope,
): void {
  const window = scope.windowed as InstanceWindow;
  const from = Date.parse(window.start);
  const to = Date.parse(window.end);
  const inside = (instant: number | null): boolean =>
    instant !== null && instant >= from && instant <= to;
  let kept = 0;
  for (const member of run.index.members(calendarGroup(planned.calendar.id))) {
    if (member.type !== OBJECT_TYPES.event || member.id === undefined || seen.has(member.id)) {
      continue;
    }
    const start = storedStart(member);
    const master = member.metadata?.eventType === "seriesMaster";
    const rangeEnd = member.metadata?.recurrenceEnd
      ? Date.parse(`${member.metadata.recurrenceEnd}T23:59:59Z`)
      : null;
    const listable = master
      ? inside(start) && inside(rangeEnd) && !scope.seriesSeen.has(member.id)
      : inside(start);
    if (listable) {
      run.removeItem(member);
      continue;
    }
    // Kept as stored, with its attachments: the view could not have listed it.
    seen.add(member.id);
    kept++;
  }
  if (kept > 0) {
    run.logger.info("group calendar events outside the calendar view kept as stored", {
      kept,
      windowStart: window.start,
      windowEnd: window.end,
    });
  }
}

/** The group calendar was read through the window: events outside it are not current. */
function warnWindowed(run: BackupRun, planned: PlannedCalendar, window: InstanceWindow): void {
  const start = window.start.slice(0, 10);
  const end = window.end.slice(0, 10);
  const reason = `the group calendar was read through its calendar view (${start} to ${end}); events outside it are kept as last backed up`;
  run.warn(
    planned.path,
    reason,
    buildCause(
      "graph.group_calendar_windowed",
      { windowStart: start, windowEnd: end },
      { message: reason },
    ),
  );
}

/** Drop the attachments (and their folder) of events a complete listing no longer has. */
function removeUnseenEventRiders(
  run: BackupRun,
  calendarId: string,
  seen: ReadonlySet<string>,
): void {
  for (const member of run.index.members(calendarGroup(calendarId))) {
    const owner = member.metadata?.[META.eventItemId];
    if (member.type !== OBJECT_TYPES.event && owner !== undefined && !seen.has(owner)) {
      run.index.removePath(member.path);
    }
  }
}

/** A calendar deleted while the backup ran: its events go with it. */
function dropCalendar(run: BackupRun, planned: PlannedCalendar): void {
  removeGroupItems(run, calendarGroup(planned.calendar.id));
  run.index.removePath(planned.path);
  delete run.state.calendars[planned.calendar.id];
  run.logger.info("calendar deleted while the backup ran", { calendarId: planned.calendar.id });
}

/**
 * The events of a calendar: a user's from `/events`, a group's through the
 * fallback-aware listing. A group calendar Graph refuses to the app becomes an
 * {@link ItemError} that says so, so the run records a warning and goes on.
 */
/** Set by {@link eventsOf} when a group calendar was read through `calendarView`. */
interface ListingScope {
  windowed?: InstanceWindow;
  /** Series whose occurrences the view listed (their master may have been unreadable). */
  readonly seriesSeen: Set<string>;
}

async function* eventsOf(
  run: BackupRun,
  planned: PlannedCalendar,
  options: CalendarPhaseOptions,
  scope: ListingScope,
): AsyncGenerator<Event, void, unknown> {
  const owner = run.owner;
  if (!isGroupOwner(owner)) {
    yield* listEvents(run.client, owner, planned.calendar.id);
    return;
  }
  const viewWindow = options.viewWindow ?? groupCalendarViewWindow(options.window, run.ctx.now());
  try {
    yield* listGroupCalendarEvents(run.client, owner.groupId, viewWindow, (error) => {
      scope.windowed = viewWindow;
      run.logger.warn("group calendar listing refused, reading the calendar view instead", {
        reason: describeError(error),
        windowStart: viewWindow.start,
        windowEnd: viewWindow.end,
      });
    });
  } catch (error) {
    if (isGraphError(error) && isGroupCalendarRefusal(error)) {
      throw new ItemError(
        `the group calendar cannot be read with the app's permissions (${describeError(error)}); check the Calendars.ReadWrite consent and any application access policy`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function syncCalendar(
  run: BackupRun,
  planned: PlannedCalendar,
  options: CalendarPhaseOptions,
): Promise<void> {
  const seen = new Set<string>();
  /** Group calendars: events with attachments, which Graph does not hand to the app. */
  let groupEventsWithAttachments = 0;
  const scope: ListingScope = { seriesSeen: new Set() };
  try {
    for await (const event of eventsOf(run, planned, options, scope)) {
      run.throwIfAborted();
      if (!event.id) {
        continue;
      }
      seen.add(event.id);
      if (event.seriesMasterId) {
        scope.seriesSeen.add(event.seriesMasterId);
      }
      if (isGroupOwner(run.owner) && event.hasAttachments === true) {
        groupEventsWithAttachments++;
      }
      run.expectMore(1);
      const itemRef = eventObjectPath(planned.path, event.subject, event.id);
      try {
        await storeEvent(run, planned, event as Event & { id: string }, options);
      } catch (error) {
        if (isVanished(error)) {
          // Deleted after the listing; the stored copy goes with removeUnseenItems below.
          seen.delete(event.id);
          run.vanished(itemRef);
        } else if (isItemLevelError(error)) {
          run.fail(itemRef, error);
        } else {
          throw error;
        }
      }
      await run.maybeCheckpoint();
    }
  } catch (error) {
    if (isVanished(error)) {
      dropCalendar(run, planned);
      return;
    }
    if (!isItemLevelError(error)) {
      throw error;
    }
    // The listing broke off: keep what the snapshot has, do not prune on a partial view.
    run.fail(planned.path, error);
    return;
  }
  if (scope.windowed) {
    // The view lists only what falls into its window: an event outside it is not proof of
    // anything and stays as stored; only one whose start lies inside and that the view did
    // not list is gone.
    removeUnseenInWindow(run, planned, seen, scope);
    warnWindowed(run, planned, scope.windowed);
  } else {
    removeUnseenItems(run, calendarGroup(planned.calendar.id), OBJECT_TYPES.event, seen);
  }
  removeUnseenEventRiders(run, planned.calendar.id, seen);
  if (groupEventsWithAttachments > 0) {
    const reason = `${groupEventsWithAttachments} event(s) of the group calendar have attachments, which are not backed up for group calendars`;
    run.warn(
      planned.path,
      reason,
      buildCause(
        "graph.group_event_attachments_not_covered",
        { count: groupEventsWithAttachments },
        { message: reason },
      ),
    );
  }
}

export async function backupCalendar(run: BackupRun, options: CalendarPhaseOptions): Promise<void> {
  if (run.progress.calendarDone) {
    return;
  }
  run.enterPhase("calendar");
  let calendars: CalendarInfo[];
  try {
    calendars = await collect(listCalendars(run.client, run.owner));
  } catch (error) {
    if (isAreaRefused(error)) {
      // Mail was readable (the mail phase got through), so a refusal here is a missing
      // permission or a mail-only RBAC/access-policy scope: fail this area, keep the
      // mail of this run. Nothing is pruned, the objects of the last snapshot stay.
      run.fail(CALENDAR_ROOT, error);
      return;
    }
    const wrapped = toMailboxAccessError(error, "calendars");
    if (!isItemLevelError(wrapped)) {
      throw wrapped;
    }
    run.fail(CALENDAR_ROOT, error);
    return;
  }

  const paths = assignFolderPaths(
    CALENDAR_ROOT,
    calendars.map((calendar) => ({ id: calendar.id, parentId: null, name: calendar.name ?? "" })),
  );
  const planned: PlannedCalendar[] = calendars.map((calendar) => ({
    calendar,
    path: paths.get(calendar.id) ?? CALENDAR_ROOT,
    displayPath: displayFolderPath([calendar.name ?? ""]),
  }));
  run.state.calendars = reconcileGroupFolders(run, {
    groupPrefix: "calendar:",
    folderKind: FOLDER_KIND_CALENDAR,
    keyMetadata: META.calendarId,
    previousPaths: run.state.calendars,
    current: planned.map((entry) => ({
      key: entry.calendar.id,
      path: entry.path,
      object: calendarFolderObject(entry),
      itemMetadata: calendarLocation(entry),
    })),
  });
  run.logger.info("calendars enumerated", { calendars: calendars.length });

  for (const entry of planned) {
    run.throwIfAborted();
    await syncCalendar(run, entry, options);
  }
  run.progress.calendarDone = true;
  await run.checkpoint();
}
