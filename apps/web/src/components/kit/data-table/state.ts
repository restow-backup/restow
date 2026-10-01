import type { ColumnDef, PaginationState } from "@tanstack/react-table";

/**
 * TanStack options the kit sets on every table. `autoResetPageIndex` is off
 * because TanStack's default sends a client-paginated table back to page 1
 * whenever `data` changes, so a refetch on window focus would throw the user
 * off page 3. The kit returns to the first page itself, and only when the
 * order or a filter changes.
 */
export const TABLE_DEFAULTS = {
  autoResetPageIndex: false,
  enableSortingRemoval: false,
  enableMultiSort: false,
} as const;

/** What the table body shows. */
export type BodyState = "loading" | "error" | "empty" | "filteredEmpty" | "rows";

export interface BodyStateInput {
  /** The first load is running. */
  loading: boolean;
  /** Rows were loaded at least once (`data` is not undefined). */
  hasData: boolean;
  error: unknown;
  rowCount: number;
  filtered: boolean;
}

/**
 * Loaded data always wins: a background refetch or a failed refresh keeps the
 * last rows (or the last empty state) on screen, and the failure shows above
 * the table instead (see `hasStaleError`).
 */
export function bodyState({
  loading,
  hasData,
  error,
  rowCount,
  filtered,
}: BodyStateInput): BodyState {
  if (!hasData && loading) {
    return "loading";
  }
  if (!hasData && error !== undefined && error !== null) {
    return "error";
  }
  if (rowCount === 0) {
    return filtered ? "filteredEmpty" : "empty";
  }
  return "rows";
}

/**
 * A refresh failed after data was loaded once. Whatever the body shows then
 * (rows, the empty or the filtered-empty state) is from the last successful
 * load, and the table says so rather than passing it off as fresh.
 */
export function hasStaleError(hasData: boolean, error: unknown): boolean {
  return hasData && error !== undefined && error !== null;
}

/** Structural equality for the small, JSON-shaped table state (sorting, filters). */
export function sameState(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two pagination states point at the same page. */
export function samePage(a: PaginationState, b: PaginationState): boolean {
  return a.pageIndex === b.pageIndex && a.pageSize === b.pageSize;
}

/**
 * The page to show when the rows shrank under the open one (a refetch, a
 * deletion, a narrower filter): the last page that still exists, or the first
 * page when nothing is left.
 */
export function clampPageIndex(pageIndex: number, pageCount: number): number {
  if (pageCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, pageIndex), pageCount - 1);
}

/** `aria-sort` of a column header; `undefined` for columns that cannot sort. */
export function ariaSortFor(
  canSort: boolean,
  sorted: false | "asc" | "desc",
): "ascending" | "descending" | "none" | undefined {
  if (!canSort) {
    return undefined;
  }
  if (sorted === "asc") {
    return "ascending";
  }
  if (sorted === "desc") {
    return "descending";
  }
  return "none";
}

/** First and last row number shown on a page (1-based), `{0, 0}` when empty. */
export function pageRange(
  pageIndex: number,
  pageSize: number,
  total: number,
): { from: number; to: number } {
  if (total <= 0 || pageSize <= 0) {
    return { from: 0, to: 0 };
  }
  const from = Math.min(total, pageIndex * pageSize + 1);
  const to = Math.min(total, (pageIndex + 1) * pageSize);
  return { from, to };
}

/** The id TanStack Table gives a column definition (id, accessor key, string header). */
export function columnIdOf<TData, TValue>(column: ColumnDef<TData, TValue>): string | undefined {
  if (column.id) {
    return column.id;
  }
  const accessorKey = (column as { accessorKey?: unknown }).accessorKey;
  if (typeof accessorKey === "string") {
    return accessorKey.replaceAll(".", "_");
  }
  return typeof column.header === "string" ? column.header : undefined;
}

/** The human name of a column definition (`meta.label` or a string header), or `null`. */
export function columnDefLabel<TData, TValue>(column: ColumnDef<TData, TValue>): string | null {
  if (column.meta?.label) {
    return column.meta.label;
  }
  return typeof column.header === "string" ? column.header : null;
}

/** The nested definitions of a header group, or `null` for a leaf column. */
function subColumnsOf<TData, TValue>(
  column: ColumnDef<TData, TValue>,
): readonly ColumnDef<TData, unknown>[] | null {
  const nested = (column as { columns?: unknown }).columns;
  // TanStack treats a group without columns as a leaf, so the kit does too.
  return Array.isArray(nested) && nested.length > 0
    ? (nested as ColumnDef<TData, unknown>[])
    : null;
}

/**
 * Ids of the leaf columns listed in the columns menu: they may hide
 * (`enableHiding` not false) and have a name to list them under. Header
 * groups are walked down to their leaves. The menu (`DataTableViewOptions`)
 * lists the table's leaf columns by the same rule, so a column hidden from
 * storage always has an entry to bring it back.
 */
export function hideableColumnIds<TData, TValue>(
  columns: readonly ColumnDef<TData, TValue>[],
): Set<string> {
  const ids = new Set<string>();
  const visit = (defs: readonly ColumnDef<TData, unknown>[]) => {
    for (const column of defs) {
      const nested = subColumnsOf(column);
      if (nested) {
        visit(nested);
        continue;
      }
      const id = columnIdOf(column);
      if (id && column.enableHiding !== false && columnDefLabel(column) !== null) {
        ids.add(id);
      }
    }
  };
  visit(columns as readonly ColumnDef<TData, unknown>[]);
  return ids;
}
