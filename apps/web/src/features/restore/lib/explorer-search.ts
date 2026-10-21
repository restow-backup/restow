import { z } from "zod";

import { normalizePath } from "@/features/restore/lib/paths";

/**
 * The explorer's state in the URL: which object, which point in time, which
 * folder, which item is open and what is searched. Keeping it in the URL
 * makes every view linkable and lets back/forward walk through folders.
 * Unknown or malformed values are dropped instead of breaking the page.
 */

const optionalUuid = z.string().uuid().optional().catch(undefined);
const optionalText = z.string().max(4096).optional().catch(undefined);

export const explorerSearchSchema = z.object({
  object: optionalUuid,
  snapshot: optionalUuid,
  /** Folder being browsed ("" or absent is the root). */
  path: optionalText,
  /** Path of the entry shown in the details panel. */
  item: optionalText,
  /** Search text within the snapshot. */
  q: z.string().max(200).optional().catch(undefined),
  /** Item list order; absent means the default (date, newest first). */
  sort: z.enum(["date", "upcoming", "name"]).optional().catch(undefined),
  /** A calendar's view: absent is the list, `month` the month (`month`, YYYY-MM). */
  view: z.enum(["month"]).optional().catch(undefined),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .catch(undefined),
  /** The tab: absent is browsing, `recent` the list of recent restores. */
  tab: z.enum(["recent"]).optional().catch(undefined),
});

export type ExplorerSearch = z.infer<typeof explorerSearchSchema>;

export function parseExplorerSearch(raw: unknown): ExplorerSearch {
  return explorerSearchSchema.parse(raw ?? {});
}

/** Drop empty values so the URL stays short and canonical. */
export function compactSearch(search: ExplorerSearch): ExplorerSearch {
  const compact: ExplorerSearch = {};
  if (search.object) compact.object = search.object;
  if (search.snapshot) compact.snapshot = search.snapshot;
  const path = normalizePath(search.path);
  if (path) compact.path = path;
  const item = normalizePath(search.item);
  if (item) compact.item = item;
  if (search.q?.trim()) compact.q = search.q;
  if (search.sort && search.sort !== "date") compact.sort = search.sort;
  if (search.view) compact.view = search.view;
  if (search.view && search.month) compact.month = search.month;
  return compact;
}

/** Another mailbox or drive: everything below the object starts over. */
export function withObject(objectId: string, path?: string): ExplorerSearch {
  return path ? { object: objectId, path: normalizePath(path) } : { object: objectId };
}

/**
 * Another point in time of the same object: keep the folder and the open
 * item, so the same place can be compared across snapshots.
 */
export function withSnapshot(search: ExplorerSearch, snapshotId: string): ExplorerSearch {
  return { ...search, snapshot: snapshotId };
}

/**
 * Open a folder: its contents replace the list, the details panel closes. The month view stays
 * while the folder is a calendar too.
 */
export function withFolder(search: ExplorerSearch, path: string): ExplorerSearch {
  const next = normalizePath(path);
  const calendar = isCalendarPath(next);
  return {
    ...search,
    path: next,
    item: undefined,
    q: undefined,
    view: calendar ? search.view : undefined,
    month: calendar ? search.month : undefined,
  };
}

/** The calendar area of a mailbox restore point (`calendar` and the calendars below it). */
export function isCalendarPath(path: string | undefined): boolean {
  const normalized = normalizePath(path);
  return normalized === "calendar" || normalized.startsWith("calendar/");
}

/** The list or the month view of a calendar, and which month. */
export function withCalendarView(
  search: ExplorerSearch,
  view: "list" | "month",
  month?: string,
): ExplorerSearch {
  return view === "list"
    ? { ...search, view: undefined, month: undefined }
    : { ...search, view: "month", month, item: undefined };
}

/** Show an item's details (and its version history). */
export function withItem(search: ExplorerSearch, path: string | undefined): ExplorerSearch {
  return { ...search, item: path === undefined ? undefined : normalizePath(path) };
}

export function withQuery(search: ExplorerSearch, q: string): ExplorerSearch {
  return { ...search, q: q.length > 0 ? q : undefined, item: undefined };
}

/** Change how the item list orders a folder's contents (folders always come first). */
export function withSort(
  search: ExplorerSearch,
  sort: NonNullable<ExplorerSearch["sort"]>,
): ExplorerSearch {
  return { ...search, sort };
}

/** The object the explorer opens with: the viewer's own mailbox or drive first. */
export function preferredObject<T extends { own: boolean }>(objects: readonly T[]): T | null {
  return objects.find((object) => object.own) ?? objects[0] ?? null;
}

/** Search results replace the folder listing once the query is long enough. */
export const SEARCH_MIN_LENGTH = 2;

export function activeQuery(search: ExplorerSearch): string | null {
  const query = search.q?.trim() ?? "";
  return query.length >= SEARCH_MIN_LENGTH ? query : null;
}
