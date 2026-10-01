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
  sort: z.enum(["date", "name"]).optional().catch(undefined),
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
  return compact;
}

/** Another mailbox or drive: everything below the object starts over. */
export function withObject(objectId: string): ExplorerSearch {
  return { object: objectId };
}

/**
 * Another point in time of the same object: keep the folder and the open
 * item, so the same place can be compared across snapshots.
 */
export function withSnapshot(search: ExplorerSearch, snapshotId: string): ExplorerSearch {
  return { ...search, snapshot: snapshotId };
}

/** Open a folder: its contents replace the list, the details panel closes. */
export function withFolder(search: ExplorerSearch, path: string): ExplorerSearch {
  return { ...search, path: normalizePath(path), item: undefined, q: undefined };
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
