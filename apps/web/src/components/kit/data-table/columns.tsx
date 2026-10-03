import type { Column, Row, RowData } from "@tanstack/react-table";

import type { RowActionsDefinition } from "./row-actions.js";
import { columnDefLabel } from "./state.js";

declare module "@tanstack/react-table" {
  /**
   * Presentation hints the kit's DataTable reads from `columnDef.meta`. The
   * type parameters are unused but must match the declaration being merged.
   */
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Human name for the column menu and the sort button; defaults to a string header. */
    label?: string;
    /** Right-aligned tabular numbers (sizes, counts, durations). */
    numeric?: boolean;
    /** Classes for header and cells, e.g. `hidden md:table-cell` or a width. */
    className?: string;
    headerClassName?: string;
    cellClassName?: string;
    /**
     * Tooltip of the cell when its column is single-line (a pinned column or
     * one with a `maxSize`) and cuts its text off. Without it the tooltip is
     * the cell's own value when it is plain text; a custom cell titles itself.
     */
    cellTitle?: (row: TData) => string | undefined;
    /**
     * The row actions of the table (set by `rowActionsColumn`): `DataTable` offers them as the
     * context menu of each row as well.
     */
    rowActions?: RowActionsDefinition<unknown>;
  }
}

/** The human name of a column, or `null` when it has none to show. */
export function columnLabel<TData, TValue>(column: Column<TData, TValue>): string | null {
  return columnDefLabel(column.columnDef);
}

/**
 * Filter function for faceted filters: the cell value is one of the selected
 * values (an empty selection matches everything).
 */
export function matchesAnyOf<TData extends RowData>(
  row: Row<TData>,
  columnId: string,
  filterValue: unknown,
): boolean {
  if (!Array.isArray(filterValue) || filterValue.length === 0) {
    return true;
  }
  return filterValue.includes(row.getValue(columnId));
}

export {
  type RowAction,
  RowActionsMenu,
  type RowActionsMenuProps,
  type RowActionsColumnOptions,
  rowActionsColumn,
} from "./row-actions.js";
