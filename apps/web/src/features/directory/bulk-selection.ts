import type { BulkProtectionTarget, ObjectsFilter } from "./types";

/**
 * Selection state of the protected-objects table: either explicit ids
 * (checked rows, which may span several page visits) or "every object the
 * current filter matches" ("select all N matching"), which the bulk API
 * resolves itself so it always covers rows the table never paged through.
 * Pure and unit-tested; the panel only stores and renders this.
 */
export interface BulkSelectionState {
  readonly mode: "ids" | "allMatching";
  readonly ids: ReadonlySet<string>;
}

export const EMPTY_SELECTION: BulkSelectionState = { mode: "ids", ids: new Set() };

export function isEmpty(state: BulkSelectionState): boolean {
  return state.mode === "ids" && state.ids.size === 0;
}

export function isSelected(state: BulkSelectionState, id: string): boolean {
  return state.mode === "allMatching" || state.ids.has(id);
}

/** Every id of the current page is checked (and the page is not empty). */
export function isPageFullySelected(
  state: BulkSelectionState,
  pageIds: readonly string[],
): boolean {
  return (
    pageIds.length > 0 && (state.mode === "allMatching" || pageIds.every((id) => state.ids.has(id)))
  );
}

/** Some but not all of the page is checked: the header checkbox's indeterminate state. */
export function isPagePartiallySelected(
  state: BulkSelectionState,
  pageIds: readonly string[],
): boolean {
  if (state.mode === "allMatching") {
    return false;
  }
  const checked = pageIds.filter((id) => state.ids.has(id)).length;
  return checked > 0 && checked < pageIds.length;
}

/** Check or uncheck one row. Touching a row while "all matching" is active starts a fresh pick. */
export function toggleRow(state: BulkSelectionState, id: string): BulkSelectionState {
  if (state.mode === "allMatching") {
    return { mode: "ids", ids: new Set([id]) };
  }
  const ids = new Set(state.ids);
  if (ids.has(id)) {
    ids.delete(id);
  } else {
    ids.add(id);
  }
  return { mode: "ids", ids };
}

/** The header checkbox: check every row of the page, or clear it if it was already full. */
export function togglePage(
  state: BulkSelectionState,
  pageIds: readonly string[],
): BulkSelectionState {
  if (isPageFullySelected(state, pageIds)) {
    if (state.mode === "allMatching") {
      return EMPTY_SELECTION;
    }
    const ids = new Set(state.ids);
    for (const id of pageIds) {
      ids.delete(id);
    }
    return { mode: "ids", ids };
  }
  const ids = new Set(state.ids);
  for (const id of pageIds) {
    ids.add(id);
  }
  return { mode: "ids", ids };
}

export function selectAllMatching(): BulkSelectionState {
  return { mode: "allMatching", ids: new Set() };
}

export function clearSelection(): BulkSelectionState {
  return EMPTY_SELECTION;
}

/** How many objects the selection covers, given how many the filter matches in total. */
export function selectionCount(state: BulkSelectionState, totalMatching: number): number {
  return state.mode === "allMatching" ? totalMatching : state.ids.size;
}

/** What the bulk protection endpoint expects for the current selection. */
export function bulkTarget(state: BulkSelectionState, filter: ObjectsFilter): BulkProtectionTarget {
  return state.mode === "allMatching" ? { filter } : { objectIds: [...state.ids] };
}
