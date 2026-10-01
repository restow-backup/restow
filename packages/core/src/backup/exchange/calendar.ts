/**
 * Calendar phase: every calendar of the mailbox, its single instances and
 * series masters as Graph JSON, each master bundled with the exceptions of its
 * series inside the backup window (docs/MICROSOFT.md: masters plus exceptions,
 * never `calendarView`). Calendars have no delta in v1.0, so each run lists
 * them fully; unchanged events are recognised by their bytes and cost nothing.
 *
 * Event attachments are not part of the event JSON and are not backed up in
 * v1; `hasAttachments` in the metadata says when an event had any.
 */
import type { Event } from "@microsoft/microsoft-graph-types";
import {
  type CalendarInfo,
  type InstanceWindow,
  listCalendars,
  listEvents,
  listSeriesExceptions,
} from "../../graph/resources/calendar.js";
import { collect } from "../../graph/resources/common.js";
import {
  folderObjectAt,
  reconcileGroupFolders,
  removeGroupItems,
  removeUnseenItems,
  storeJsonItem,
} from "./folders.js";
import { CALENDAR_ROOT, assignFolderPaths, displayFolderPath, eventObjectPath } from "./paths.js";
import {
  type BackupRun,
  META,
  OBJECT_TYPES,
  calendarGroup,
  isItemLevelError,
  isVanished,
  toMailboxAccessError,
} from "./run.js";
import { toMillis } from "./time.js";

export const FOLDER_KIND_CALENDAR = "calendar";

export interface CalendarPhaseOptions {
  readonly window: InstanceWindow;
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

export function eventMetadata(
  event: Event,
  location: Record<string, string>,
  exceptionCount: number,
): Record<string, string> {
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
  };
}

async function storeEvent(
  run: BackupRun,
  planned: PlannedCalendar,
  event: Event & { id: string },
  options: CalendarPhaseOptions,
): Promise<void> {
  const exceptions =
    event.type === "seriesMaster"
      ? await listSeriesExceptions(run.client, run.userId, event, options.window)
      : [];
  const payload: StoredEvent = { event, exceptions };
  await storeJsonItem(run, {
    type: OBJECT_TYPES.event,
    id: event.id,
    path: eventObjectPath(planned.path, event.subject, event.id),
    mtime: toMillis(event.lastModifiedDateTime) || toMillis(event.createdDateTime),
    metadata: eventMetadata(event, calendarLocation(planned), exceptions.length),
    payload,
  });
}

/** A calendar deleted while the backup ran: its events go with it. */
function dropCalendar(run: BackupRun, planned: PlannedCalendar): void {
  removeGroupItems(run, calendarGroup(planned.calendar.id));
  run.index.removePath(planned.path);
  delete run.state.calendars[planned.calendar.id];
  run.logger.info("calendar deleted while the backup ran", { calendarId: planned.calendar.id });
}

async function syncCalendar(
  run: BackupRun,
  planned: PlannedCalendar,
  options: CalendarPhaseOptions,
): Promise<void> {
  const seen = new Set<string>();
  try {
    for await (const event of listEvents(run.client, run.userId, planned.calendar.id)) {
      run.throwIfAborted();
      if (!event.id) {
        continue;
      }
      seen.add(event.id);
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
  removeUnseenItems(run, calendarGroup(planned.calendar.id), OBJECT_TYPES.event, seen);
}

export async function backupCalendar(run: BackupRun, options: CalendarPhaseOptions): Promise<void> {
  if (run.progress.calendarDone) {
    return;
  }
  run.enterPhase("calendar");
  let calendars: CalendarInfo[];
  try {
    calendars = await collect(listCalendars(run.client, run.userId));
  } catch (error) {
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
