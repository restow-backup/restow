import type { ManifestObjectKind } from "@restow/db";
import { normalizePath } from "../snapshots/tree.js";
import type { SelectionEntry } from "./schemas.js";

/**
 * Turning an explorer selection into what the restore engines consume.
 *
 * The request names paths and item ids as the user clicked them; the engine
 * wants the {@link StoredSelection} shape from @restow/core (RestoreSelection:
 * `all`, `paths`, `folderPaths`, `objectIds`). Resolving one into the other
 * needs the snapshot's manifest rows (is this path a folder? does this item
 * exist?), which the service looks up; the mapping itself is pure and tested.
 */

/** Mirrors @restow/core `RestoreSelection`; stored in `restore_jobs.source_selection`. */
export interface StoredSelection {
  all?: boolean;
  paths?: string[];
  folderPaths?: string[];
  objectIds?: string[];
}

/** What the service found in the snapshot for the requested entries. */
export interface SelectionLookup {
  /** Kind of every existing manifest row whose path was requested. */
  kindByPath: ReadonlyMap<string, ManifestObjectKind>;
  /** Requested paths that exist only as a parent of other rows (no folder row of their own). */
  implicitFolders: ReadonlySet<string>;
  /** Requested item ids that exist in the snapshot. */
  knownItemIds: ReadonlySet<string>;
}

/** Counts shown in the UI and written to the audit log. */
export interface SelectionSummary {
  all: boolean;
  folders: number;
  items: number;
}

export type ResolvedSelection =
  | { ok: true; selection: StoredSelection; summary: SelectionSummary }
  | { ok: false; unknown: string[] };

function isRoot(path: string): boolean {
  return normalizePath(path).length === 0;
}

/** Split the request into the paths and item ids the service must look up. */
export function requestedKeys(entries: readonly SelectionEntry[]): {
  paths: string[];
  itemIds: string[];
} {
  const paths = new Set<string>();
  const itemIds = new Set<string>();
  for (const entry of entries) {
    if ("itemId" in entry) {
      itemIds.add(entry.itemId);
    } else if (!isRoot(entry.path)) {
      paths.add(normalizePath(entry.path));
    }
  }
  return { paths: [...paths], itemIds: [...itemIds] };
}

/**
 * Resolve entries against the lookup. A root path selects everything (other
 * entries become redundant). Unknown paths or ids fail the whole request: a
 * restore must never silently restore less than asked.
 */
export function resolveSelection(
  entries: readonly SelectionEntry[],
  lookup: SelectionLookup,
): ResolvedSelection {
  const folderPaths = new Set<string>();
  const paths = new Set<string>();
  const objectIds = new Set<string>();
  const unknown: string[] = [];
  let all = false;

  for (const entry of entries) {
    if ("itemId" in entry) {
      if (lookup.knownItemIds.has(entry.itemId)) {
        objectIds.add(entry.itemId);
      } else {
        unknown.push(`itemId:${entry.itemId}`);
      }
      continue;
    }
    if (isRoot(entry.path)) {
      all = true;
      continue;
    }
    const path = normalizePath(entry.path);
    const kind = lookup.kindByPath.get(path);
    if (kind === "folder" || (kind === undefined && lookup.implicitFolders.has(path))) {
      folderPaths.add(path);
    } else if (kind !== undefined) {
      paths.add(path);
    } else {
      unknown.push(`path:${path}`);
    }
  }

  if (unknown.length > 0) {
    return { ok: false, unknown };
  }
  if (all) {
    return { ok: true, selection: { all: true }, summary: { all: true, folders: 0, items: 0 } };
  }
  // Drop paths and ids already covered by a selected folder.
  const covered = (path: string) =>
    [...folderPaths].some((folder) => path === folder || path.startsWith(`${folder}/`));
  const nestedFolders = [...folderPaths].filter((folder) =>
    [...folderPaths].some((other) => other !== folder && folder.startsWith(`${other}/`)),
  );
  for (const nested of nestedFolders) {
    folderPaths.delete(nested);
  }
  for (const path of [...paths]) {
    if (covered(path)) {
      paths.delete(path);
    }
  }

  const selection: StoredSelection = {};
  if (folderPaths.size > 0) selection.folderPaths = [...folderPaths].sort();
  if (paths.size > 0) selection.paths = [...paths].sort();
  if (objectIds.size > 0) selection.objectIds = [...objectIds].sort();
  return {
    ok: true,
    selection,
    summary: { all: false, folders: folderPaths.size, items: paths.size + objectIds.size },
  };
}

/** The summary of a stored selection (for lists and the audit log). */
export function summarizeSelection(selection: StoredSelection): SelectionSummary {
  if (selection.all) {
    return { all: true, folders: 0, items: 0 };
  }
  return {
    all: false,
    folders: selection.folderPaths?.length ?? 0,
    items: (selection.paths?.length ?? 0) + (selection.objectIds?.length ?? 0),
  };
}

/** Read a stored selection back tolerantly (the column is free-form jsonb). */
export function parseStoredSelection(value: unknown): StoredSelection {
  if (!value || typeof value !== "object") {
    return { all: true };
  }
  const record = value as Record<string, unknown>;
  const strings = (input: unknown): string[] | undefined =>
    Array.isArray(input) && input.every((item) => typeof item === "string")
      ? (input as string[])
      : undefined;
  const selection: StoredSelection = {};
  if (record.all === true) selection.all = true;
  const paths = strings(record.paths);
  const folderPaths = strings(record.folderPaths);
  const objectIds = strings(record.objectIds);
  if (paths) selection.paths = paths;
  if (folderPaths) selection.folderPaths = folderPaths;
  if (objectIds) selection.objectIds = objectIds;
  if (!selection.all && !paths?.length && !folderPaths?.length && !objectIds?.length) {
    selection.all = true;
  }
  return selection;
}
