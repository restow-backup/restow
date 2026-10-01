import type { EntryKind, SelectionEntry, TreeEntry } from "@/features/restore/api";
import { ROOT_PATH, isWithin } from "@/features/restore/lib/paths";

/**
 * The explorer's multi-selection: what the user ticked in one snapshot,
 * keyed by path (unique within a snapshot). Pure and immutable, so the page
 * state is a plain value and every transition is unit-tested. A selection
 * can span folders; it belongs to one snapshot and is dropped when the point
 * in time changes.
 */

export interface SelectedEntry {
  path: string;
  kind: EntryKind;
  itemId: string | null;
  /** Mail subject when known (for the label). */
  subject: string | null;
  size: number;
}

export type Selection = ReadonlyMap<string, SelectedEntry>;

export const EMPTY_SELECTION: Selection = new Map();

export function toSelectedEntry(entry: TreeEntry): SelectedEntry {
  return {
    path: entry.path,
    kind: entry.kind,
    itemId: entry.itemId,
    subject: entry.mail?.subject ?? null,
    size: entry.size,
  };
}

export function isSelected(selection: Selection, path: string): boolean {
  return selection.has(path);
}

/** The selected folder that already includes `path`, if any (the entry itself excluded). */
export function coveringFolder(selection: Selection, path: string): SelectedEntry | null {
  for (const selected of selection.values()) {
    if (selected.kind === "folder" && selected.path !== path && isWithin(path, selected.path)) {
      return selected;
    }
  }
  return null;
}

/** True when the entry, or a folder above it, is selected. */
export function isCovered(selection: Selection, path: string): boolean {
  return selection.has(path) || coveringFolder(selection, path) !== null;
}

export function toggle(selection: Selection, entry: TreeEntry): Selection {
  const next = new Map(selection);
  if (next.has(entry.path)) {
    next.delete(entry.path);
  } else {
    next.set(entry.path, toSelectedEntry(entry));
  }
  return next;
}

export function remove(selection: Selection, path: string): Selection {
  if (!selection.has(path)) {
    return selection;
  }
  const next = new Map(selection);
  next.delete(path);
  return next;
}

/** Select every listed entry that is not already covered by a selected folder. */
export function selectAll(selection: Selection, entries: readonly TreeEntry[]): Selection {
  const next = new Map(selection);
  for (const entry of entries) {
    if (!coveringFolder(selection, entry.path)) {
      next.set(entry.path, toSelectedEntry(entry));
    }
  }
  return next;
}

/** Deselect every listed entry. */
export function deselectAll(selection: Selection, entries: readonly TreeEntry[]): Selection {
  const next = new Map(selection);
  for (const entry of entries) {
    next.delete(entry.path);
  }
  return next;
}

export type ListSelectionState = "none" | "some" | "all";

/** How much of a listing is selected or covered (drives the header checkbox). */
export function listSelectionState(
  selection: Selection,
  entries: readonly TreeEntry[],
): ListSelectionState {
  if (entries.length === 0) {
    return "none";
  }
  let selected = 0;
  for (const entry of entries) {
    if (isCovered(selection, entry.path)) {
      selected += 1;
    }
  }
  if (selected === 0) return "none";
  return selected === entries.length ? "all" : "some";
}

export interface SelectionCounts {
  folders: number;
  items: number;
  total: number;
  /** Bytes of the selected items; folder contents are not known up front. */
  bytes: number;
}

export function countSelection(selection: Selection): SelectionCounts {
  let folders = 0;
  let items = 0;
  let bytes = 0;
  for (const entry of selection.values()) {
    if (entry.kind === "folder") {
      folders += 1;
    } else {
      items += 1;
      bytes += entry.size;
    }
  }
  return { folders, items, total: folders + items, bytes };
}

/** The request body entries: folders and items by path (the server checks them against the snapshot). */
export function toApiSelection(selection: Selection): SelectionEntry[] {
  return [...selection.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => ({ path: entry.path, kind: entry.kind === "folder" ? "folder" : "item" }));
}

/** The selection that restores a whole snapshot. */
export function everythingSelection(): SelectionEntry[] {
  return [{ path: ROOT_PATH, kind: "folder" }];
}

/** A selection of just these entries (a single item, a version). */
export function selectionOf(...entries: SelectedEntry[]): Selection {
  return new Map(entries.map((entry) => [entry.path, entry]));
}
