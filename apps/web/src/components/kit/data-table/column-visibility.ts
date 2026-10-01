import type { VisibilityState } from "@tanstack/react-table";

/**
 * Column visibility is remembered per table id in localStorage. Storage can
 * be missing or throw (private mode, blocked site data, quota), so every
 * access is guarded: a failure means "nothing remembered", never a crash.
 */

/** The part of the Storage API used here (injectable for tests). */
export type VisibilityStorage = Pick<Storage, "getItem" | "setItem">;

export function columnVisibilityKey(tableId: string): string {
  return `restow.table.${tableId}.columns`;
}

/** `globalThis.localStorage`, or `null` where reading it is impossible or throws. */
function defaultStorage(): VisibilityStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The remembered visibility of `tableId`; `{}` when nothing usable is stored. */
export function readColumnVisibility(
  tableId: string,
  storage: VisibilityStorage | null = defaultStorage(),
): VisibilityState {
  try {
    const raw = storage?.getItem(columnVisibilityKey(tableId));
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const state: VisibilityState = {};
    for (const [columnId, visible] of Object.entries(parsed)) {
      if (typeof visible === "boolean") {
        state[columnId] = visible;
      }
    }
    return state;
  } catch {
    return {};
  }
}

/** Remember `state` for `tableId`; silently does nothing when storage fails. */
export function writeColumnVisibility(
  tableId: string,
  state: VisibilityState,
  storage: VisibilityStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(columnVisibilityKey(tableId), JSON.stringify(state));
  } catch {
    // The choice still applies until the page is reloaded.
  }
}

/**
 * Keep only entries for columns listed in the columns menu, so a stored
 * `false` can never hide a column that has no menu entry to bring it back.
 * A state that would hide every listed column is dropped as a whole: the
 * menu never allows that, so it can only be stale.
 */
export function sanitizeVisibility(
  state: VisibilityState,
  hideableColumnIds: ReadonlySet<string>,
): VisibilityState {
  const result: VisibilityState = {};
  for (const [columnId, visible] of Object.entries(state)) {
    if (hideableColumnIds.has(columnId)) {
      result[columnId] = visible;
    }
  }
  const hidesAll =
    hideableColumnIds.size > 0 && [...hideableColumnIds].every((id) => result[id] === false);
  return hidesAll ? {} : result;
}

/**
 * What to remember after the user set the listed columns to `next`. Entries
 * of columns that are not listed right now stay: a column that is missing
 * for a while (shown only on some installations, or once the session loaded)
 * gets its remembered state back when it returns.
 */
export function mergeVisibility(
  remembered: VisibilityState,
  next: VisibilityState,
  hideableColumnIds: ReadonlySet<string>,
): VisibilityState {
  const result: VisibilityState = {};
  for (const [columnId, visible] of Object.entries(remembered)) {
    if (!hideableColumnIds.has(columnId)) {
      result[columnId] = visible;
    }
  }
  for (const [columnId, visible] of Object.entries(next)) {
    if (hideableColumnIds.has(columnId)) {
      result[columnId] = visible;
    }
  }
  return result;
}

/** The stored visibility of one table, unfiltered, as the table holds it in memory. */
export interface RememberedVisibility {
  tableId: string;
  state: VisibilityState;
}

/**
 * The remembered visibility for `tableId`: `current` itself while the id is
 * unchanged, otherwise that table's entry read from storage.
 */
export function rememberedFor(
  current: RememberedVisibility | null,
  tableId: string,
  read: (tableId: string) => VisibilityState = readColumnVisibility,
): RememberedVisibility {
  if (current !== null && current.tableId === tableId) {
    return current;
  }
  return { tableId, state: read(tableId) };
}
