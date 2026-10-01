import {
  type ColumnDef,
  type Updater,
  type VisibilityState,
  functionalUpdate,
} from "@tanstack/react-table";
import * as React from "react";

import {
  mergeVisibility,
  rememberedFor,
  sanitizeVisibility,
  writeColumnVisibility,
} from "./column-visibility.js";
import { hideableColumnIds } from "./state.js";

/**
 * Ids of the columns listed in the columns menu, as a set whose identity
 * changes only when the ids do: pages may pass a new `columns` array on every
 * render, and the visibility derived from this set should stay stable then.
 */
export function useHideableColumnIds<TData, TValue>(
  columns: readonly ColumnDef<TData, TValue>[],
): ReadonlySet<string> {
  const key = JSON.stringify([...hideableColumnIds(columns)].sort());
  return React.useMemo(() => new Set<string>(JSON.parse(key) as string[]), [key]);
}

/**
 * The column visibility of table `tableId`, remembered in localStorage.
 *
 * The stored entry is held in memory unfiltered, and what applies is derived
 * from it on every render against the columns listed right now. So a column
 * that becomes hideable later (one shown only once the session is known)
 * gets its remembered state back, and a new `tableId`
 * reads that table's entry instead of carrying over the old one.
 */
export function useColumnVisibility(
  tableId: string,
  hideable: ReadonlySet<string>,
): readonly [VisibilityState, (updater: Updater<VisibilityState>) => void] {
  const [remembered, setRemembered] = React.useState(() => rememberedFor(null, tableId));
  const current = rememberedFor(remembered, tableId);
  if (current !== remembered) {
    // Another table id: switch while rendering, so the old entry never shows.
    setRemembered(current);
  }
  const stored = current.state;
  const visibility = React.useMemo(() => sanitizeVisibility(stored, hideable), [stored, hideable]);

  const onChange = (updater: Updater<VisibilityState>) => {
    const next = mergeVisibility(stored, functionalUpdate(updater, visibility), hideable);
    setRemembered({ tableId, state: next });
    writeColumnVisibility(tableId, next);
  };

  return [visibility, onChange] as const;
}
