import { Link } from "@tanstack/react-router";
import {
  type Cell,
  type ColumnDef,
  type ColumnFiltersState,
  type Header,
  type PaginationState,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Table as TanstackTable,
  type Updater,
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Inbox,
  RotateCw,
  SearchX,
  TriangleAlert,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { EmptyState } from "../empty-state.js";
import { UI_NAMESPACE } from "../i18n.js";
import { columnLabel } from "./columns.js";
import { DataTableLoadMore, DataTablePagination } from "./pagination.js";
import { columnPin, declaredWidths, pinningState, truncatedTitle, widthStyle } from "./pinning.js";
import { type RowAction, RowContextMenu, rowActionsOf } from "./row-actions.js";
import {
  TABLE_DEFAULTS,
  ariaSortFor,
  bodyState,
  clampPageIndex,
  hasStaleError,
  plainCell,
  samePage,
  sameState,
} from "./state.js";
import { DataTableViewOptions } from "./toolbar.js";
import { useColumnVisibility, useHideableColumnIds } from "./use-column-visibility.js";

/**
 * Client sorting (in the browser) or manual sorting (the server sorts). In
 * manual mode the page owns the order: when it changes, the page should also
 * request the first server page.
 */
export type DataTableSorting =
  | { mode: "client"; initial?: SortingState }
  | { mode: "manual"; state: SortingState; onChange: (next: SortingState) => void };

/**
 * Client pages, server pages (page/size/total) or a cursor with "Load more".
 * Client pages stay where they are when `data` changes (a refetch) and
 * return to the first page when the order or a filter changes.
 */
export type DataTablePaginationMode =
  | { mode: "client"; pageSize?: number; pageSizes?: readonly number[] }
  | {
      mode: "manual";
      pageIndex: number;
      pageSize: number;
      /** Total rows on the server. */
      rowCount: number;
      /** Called only when the page or the page size actually changes. */
      onChange: (next: PaginationState) => void;
      pageSizes?: readonly number[];
    }
  | { mode: "loadMore"; hasMore: boolean; loadingMore?: boolean; onLoadMore: () => void };

export interface DataTableProps<TData, TValue = unknown> {
  /** Stable, unique id; the remembered column visibility is stored under it. */
  id: string;
  columns: ColumnDef<TData, TValue>[];
  /** The rows; `undefined` until the first load finished. */
  data: readonly TData[] | undefined;
  getRowId?: (row: TData, index: number) => string;
  /** Accessible name of the table (rendered as a hidden caption). */
  label?: string;
  /** The first load is running: skeleton rows. */
  loading?: boolean;
  /** Any fetch is running (marks the table busy for assistive technology). */
  fetching?: boolean;
  /**
   * Why loading failed. Before the first successful load it replaces the
   * body (with a retry). After one it shows above the body, whether that
   * holds rows or an empty state, so stale data is never passed off as fresh.
   */
  error?: unknown;
  onRetry?: () => void;
  errorTitle?: string;
  /** Shown when there are no rows and no filter is active. */
  empty?: React.ReactNode;
  /** Shown when filters or a search hide every row. */
  filteredEmpty?: React.ReactNode;
  /** Server-side filters are active (client filters are detected automatically). */
  filtered?: boolean;
  /** Clears server-side filters; offered in the toolbar and the filtered-empty state. */
  onResetFilters?: () => void;
  /** Search and faceted filters; as a function it receives the table instance. */
  toolbar?: React.ReactNode | ((table: TanstackTable<TData>) => React.ReactNode);
  /** Right side of the toolbar, before the columns menu (export, refresh). */
  toolbarActions?: React.ReactNode;
  /** Show the columns menu when some column can be hidden (default true). */
  columnsMenu?: boolean;
  /**
   * Defaults: client sorting for client or no pagination; no sorting for
   * server-driven tables unless a manual mode is given (sorting a partial
   * page in the browser would misrepresent the order).
   */
  sorting?: DataTableSorting;
  /** Omit to show every row. */
  pagination?: DataTablePaginationMode;
  /** Skeleton rows while loading (default: 5). */
  skeletonRows?: number;
  /**
   * Caps the table's height (a CSS length such as "32rem") so the body
   * scrolls under the sticky header. By default the cap is 70% of the
   * viewport (at least 20rem) from the `md` breakpoint on, and phones scroll
   * with the page. "none" lets the table grow with the page on every screen;
   * the header then cannot stick, because the horizontally scrolling table
   * container is its scroll parent. Use "none" inside panels that scroll
   * themselves (sheets, dialogs).
   */
  maxHeight?: string;
  /**
   * Ids of the columns that stay on the left while the table scrolls
   * sideways (the name, host or job: what identifies the row), in order. Give
   * them a `size`: it is their width, and the offset of the next pinned
   * column is the sum of the sizes in front of it. On phones only the first
   * one pins.
   */
  pinnedColumns?: readonly string[];
  /**
   * Makes a row clickable: called with the row's data when the row is clicked
   * anywhere that is not itself a control (a link, button, field or menu entry
   * keeps its own click). The row looks clickable, but a pointer is the only
   * thing that uses this: the keyboard needs a control in the row that does the
   * same (the name as a button), which every user of this prop has to provide.
   */
  onRowClick?: (row: TData) => void;
  /**
   * Smallest width of the table (a number of pixels or a CSS length). Columns
   * that declare a `size` or `minSize` already keep their width, which sums
   * up to the table's minimum and follows the columns a breakpoint hides;
   * use this for a table whose columns do not.
   */
  minWidth?: number | string;
  /**
   * Rows can be selected with a checkbox in front of them. While rows are selected a bar above
   * the table says how many and offers the `selectionActions` of the row actions (see
   * `rowActionsColumn`), and the context menu of a selected row offers them too.
   */
  selectable?: boolean;
  className?: string;
}

const NO_ROWS: never[] = [];
/** A placeholder row has no hover tint, neither on the row nor on its pinned cell (see `TableRow`). */
const PLACEHOLDER_ROW = "hover:bg-transparent hover:[--row-mix:0%]";
const DEFAULT_PAGE_SIZE = 25;
/** Default height cap from the `md` breakpoint on (see `maxHeight`). */
const DEFAULT_MAX_HEIGHT = "max(20rem, 70svh)";

/**
 * The one data table of the app, on TanStack Table and the shadcn table
 * parts: client or server sorting and pagination, a load-more mode for
 * cursor APIs, a toolbar slot for search and faceted filters, a columns menu
 * remembered per table, skeleton rows, empty, filtered-empty and error
 * states, `aria-sort` on sortable headers, a sticky header and tabular
 * numbers for numeric columns (`meta.numeric`).
 *
 * The header sticks inside the table's own scroll area, which `maxHeight`
 * sizes (capped at 70% of the viewport by default on tablets and desktops).
 * Changing page, sort order or filters scrolls that area back to the top.
 *
 * Column hints live in `columnDef.meta` (`label`, `numeric`, `className`,
 * `headerClassName`, `cellClassName`). A column sorts when it has an accessor
 * and `enableSorting` is not false; use `rowActionsColumn` for row menus.
 */
export function DataTable<TData, TValue = unknown>({
  id,
  columns,
  data,
  getRowId,
  label,
  loading = false,
  fetching = false,
  error,
  onRetry,
  errorTitle,
  empty,
  filteredEmpty,
  filtered: serverFiltered = false,
  onResetFilters,
  toolbar,
  toolbarActions,
  columnsMenu = true,
  sorting,
  pagination,
  skeletonRows = 5,
  maxHeight,
  pinnedColumns,
  onRowClick,
  minWidth,
  selectable = false,
  className,
}: DataTableProps<TData, TValue>) {
  const { t } = useTranslation(UI_NAMESPACE);
  const serverDriven = pagination?.mode === "manual" || pagination?.mode === "loadMore";
  const clientFiltering = !serverDriven;
  const sortingMode = sorting?.mode ?? (serverDriven ? "off" : "client");

  const hideable = useHideableColumnIds(columns);
  const [columnVisibility, onColumnVisibilityChange] = useColumnVisibility(id, hideable);
  const [clientSorting, setClientSorting] = React.useState<SortingState>(
    sorting?.mode === "client" ? (sorting.initial ?? []) : [],
  );
  const [clientPagination, setClientPagination] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize:
      pagination?.mode === "client"
        ? (pagination.pageSize ?? DEFAULT_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE,
  });
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  // The row actions of the "…" column are also each row's context menu.
  const rowActions = React.useMemo(
    () => rowActionsOf(columns as ColumnDef<TData, unknown>[]),
    [columns],
  );
  const allColumns = React.useMemo(
    () =>
      selectable
        ? [selectionColumn<TData>(rowActions?.name), ...(columns as ColumnDef<TData, unknown>[])]
        : (columns as ColumnDef<TData, unknown>[]),
    [columns, selectable, rowActions],
  );
  const [globalFilter, setGlobalFilter] = React.useState("");

  const sortingState = sorting?.mode === "manual" ? sorting.state : clientSorting;
  const paginationState: PaginationState =
    pagination?.mode === "manual"
      ? { pageIndex: pagination.pageIndex, pageSize: pagination.pageSize }
      : clientPagination;

  // Client pages start over at the first one when the order or a filter
  // changes. A new `data` array (a refetch) keeps the page: TanStack's own
  // reset on data changes is off (TABLE_DEFAULTS).
  const toFirstPage = () => {
    setClientPagination((current) =>
      current.pageIndex === 0 ? current : { ...current, pageIndex: 0 },
    );
  };

  const onSortingChange = (updater: Updater<SortingState>) => {
    const next = functionalUpdate(updater, sortingState);
    if (sameState(next, sortingState)) {
      return;
    }
    if (sorting?.mode === "manual") {
      sorting.onChange(next);
    } else {
      setClientSorting(next);
    }
    toFirstPage();
  };

  const onColumnFiltersChange = (updater: Updater<ColumnFiltersState>) => {
    const next = functionalUpdate(updater, columnFilters);
    if (sameState(next, columnFilters)) {
      return;
    }
    setColumnFilters(next);
    toFirstPage();
  };

  const onGlobalFilterChange = (updater: Updater<string>) => {
    const next = functionalUpdate(updater, globalFilter) ?? "";
    if (next === globalFilter) {
      return;
    }
    setGlobalFilter(next);
    toFirstPage();
  };

  // Unchanged pages are dropped: no callback for the page, no re-render here.
  const onPaginationChange = (updater: Updater<PaginationState>) => {
    if (pagination?.mode === "manual") {
      const next = functionalUpdate(updater, paginationState);
      if (!samePage(next, paginationState)) {
        pagination.onChange(next);
      }
      return;
    }
    setClientPagination((current) => {
      const next = functionalUpdate(updater, current);
      return samePage(next, current) ? current : next;
    });
  };

  const paginated = pagination?.mode === "client" || pagination?.mode === "manual";
  // The selection box stays in front of the pinned columns (pinned columns come first).
  const pinned =
    selectable && pinnedColumns && pinnedColumns.length > 0
      ? [SELECT_COLUMN_ID, ...pinnedColumns]
      : pinnedColumns;
  const pinKey = (pinned ?? []).join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: pinKey is the content of pinned
  const columnPinning = React.useMemo(() => pinningState(pinned), [pinKey]);
  const table = useReactTable<TData>({
    ...TABLE_DEFAULTS,
    data: (data ?? NO_ROWS) as TData[],
    columns: allColumns,
    getRowId,
    state: {
      sorting: sortingState,
      columnVisibility,
      columnFilters,
      globalFilter,
      columnPinning,
      rowSelection,
      ...(paginated ? { pagination: paginationState } : {}),
    },
    enableRowSelection: selectable,
    onRowSelectionChange: setRowSelection,
    enableColumnPinning: columnPinning.left?.length !== 0,
    onSortingChange,
    onColumnVisibilityChange,
    onColumnFiltersChange,
    onGlobalFilterChange,
    onPaginationChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: sortingMode === "client" ? getSortedRowModel() : undefined,
    getFilteredRowModel: clientFiltering ? getFilteredRowModel() : undefined,
    getFacetedRowModel: clientFiltering ? getFacetedRowModel() : undefined,
    getFacetedUniqueValues: clientFiltering ? getFacetedUniqueValues() : undefined,
    getPaginationRowModel: pagination?.mode === "client" ? getPaginationRowModel() : undefined,
    manualSorting: sortingMode === "manual",
    manualFiltering: !clientFiltering,
    manualPagination: pagination?.mode === "manual",
    rowCount: pagination?.mode === "manual" ? pagination.rowCount : undefined,
    enableSorting: sortingMode !== "off",
  });

  // Rows can shrink under the open client page (a refetch, a deletion): land
  // on the last page that exists. Adjusted while rendering, so the empty page
  // in between never shows.
  if (pagination?.mode === "client" && data !== undefined) {
    const pageIndex = clampPageIndex(clientPagination.pageIndex, table.getPageCount());
    if (pageIndex !== clientPagination.pageIndex) {
      setClientPagination({ ...clientPagination, pageIndex });
    }
  }

  // The same for a later server page; the page owns that state, so it is
  // asked to change it. A missing total (0) leaves the page alone.
  const manualPageCount = pagination?.mode === "manual" ? table.getPageCount() : 0;
  const manualPageIndex = pagination?.mode === "manual" ? pagination.pageIndex : 0;
  React.useEffect(() => {
    if (data === undefined || manualPageCount <= 0) {
      return;
    }
    const pageIndex = clampPageIndex(manualPageIndex, manualPageCount);
    if (pageIndex !== manualPageIndex) {
      table.setPageIndex(pageIndex);
    }
  }, [data, manualPageCount, manualPageIndex, table]);

  const clientFiltered = globalFilter.trim().length > 0 || columnFilters.length > 0;
  const filtered = serverFiltered || clientFiltered;
  const resetFilters = () => {
    if (clientFiltered) {
      table.resetColumnFilters();
      table.setGlobalFilter("");
    }
    onResetFilters?.();
  };
  const canReset = clientFiltered || (serverFiltered && onResetFilters !== undefined);

  // A new page, order or filter starts at its first row, not where the last one was scrolled to.
  const frameRef = React.useRef<HTMLDivElement>(null);
  const scrollKey = JSON.stringify([
    paginationState.pageIndex,
    paginationState.pageSize,
    sortingState,
    globalFilter,
    columnFilters,
  ]);
  const lastScrollKey = React.useRef(scrollKey);
  React.useEffect(() => {
    if (lastScrollKey.current === scrollKey) {
      return;
    }
    lastScrollKey.current = scrollKey;
    const container = frameRef.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
    if (container) {
      container.scrollTop = 0;
    }
  }, [scrollKey]);

  const rows = table.getRowModel().rows;
  const state = bodyState({
    loading,
    hasData: data !== undefined,
    error,
    rowCount: rows.length,
    filtered,
  });
  const staleError = hasStaleError(data !== undefined, error);
  // Pinned columns come first, as in the header and the rows.
  const visibleColumns = [
    ...table.getLeftVisibleLeafColumns(),
    ...table.getCenterVisibleLeafColumns(),
    ...table.getRightVisibleLeafColumns(),
  ];
  const toolbarContent = typeof toolbar === "function" ? toolbar(table) : toolbar;
  // Selected rows that still exist (a refetch may have removed some).
  const selectedRows = selectable ? table.getSelectedRowModel().rows : [];
  // A selected row among several offers what can be done with all of them.
  const inSelection = (row: Row<TData>) =>
    rowActions?.selectionActions !== undefined &&
    row.getIsSelected() &&
    table.getSelectedRowModel().rows.length > 1;
  const contextActions = (row: Row<TData>): readonly RowAction[] => {
    if (!rowActions) {
      return [];
    }
    if (inSelection(row) && rowActions.selectionActions) {
      return rowActions.selectionActions(
        table.getSelectedRowModel().rows.map((selected) => selected.original),
      );
    }
    return rowActions.actions(row.original);
  };
  const contextLabel = (row: Row<TData>): string => {
    if (inSelection(row)) {
      return t("table.selection.actionsFor", { count: table.getSelectedRowModel().rows.length });
    }
    const name = rowActions?.name?.(row.original);
    return name ? t("table.actions.openFor", { name }) : t("table.actions.open");
  };
  const showColumnsMenu = columnsMenu && hideable.size > 0;
  const hasToolbar = Boolean(toolbarContent) || Boolean(toolbarActions) || showColumnsMenu;

  return (
    <div data-slot="data-table" className={cn("space-y-3", className)}>
      {hasToolbar ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {toolbarContent}
            {canReset ? (
              <Button variant="ghost" size="sm" className="h-8" onClick={resetFilters}>
                <X aria-hidden="true" />
                {t("table.resetFilters")}
              </Button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {toolbarActions}
            {showColumnsMenu ? <DataTableViewOptions table={table} /> : null}
          </div>
        </div>
      ) : null}

      {selectedRows.length > 0 ? (
        <SelectionBar
          count={selectedRows.length}
          actions={rowActions?.selectionActions?.(selectedRows.map((row) => row.original)) ?? []}
          onClear={() => table.resetRowSelection()}
        />
      ) : null}

      {staleError ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("table.error.stale")}</span>
            {onRetry ? (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={onRetry}
                loading={fetching}
              >
                <RotateCw aria-hidden="true" />
                {t("common:actions.retry")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        ref={frameRef}
        className={cn(
          "overflow-hidden rounded-lg border bg-card",
          maxHeight === undefined
            ? "md:[&_[data-slot=table-container]]:max-h-(--data-table-max-height)"
            : "[&_[data-slot=table-container]]:max-h-(--data-table-max-height)",
        )}
        style={
          { "--data-table-max-height": maxHeight ?? DEFAULT_MAX_HEIGHT } as React.CSSProperties
        }
      >
        {/* One live region stays mounted and only its text changes: screen readers
            often skip a region that appears together with its text. */}
        <p className="sr-only" aria-live="polite" aria-atomic="true" data-slot="data-table-status">
          {state === "loading" ? t("table.loading") : ""}
        </p>
        <Table
          aria-busy={state === "loading" || fetching || undefined}
          style={minWidth === undefined ? undefined : { minWidth }}
          scrollLabel={label}
          containerClassName="@container scroll-pt-10"
        >
          {label ? <caption className="sr-only">{label}</caption> : null}
          {/* The row border would scroll away under the sticky cells; they draw the line instead. */}
          <TableHeader className="[&_tr]:border-b-0">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => (
                  <HeaderCell key={header.id} header={header} />
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {state === "rows" ? (
              rows.map((row) => (
                <RowContextMenu
                  key={row.id}
                  enabled={rowActions !== undefined}
                  actions={() => contextActions(row)}
                  label={contextLabel(row)}
                >
                  <TableRow
                    // The context menu's trigger owns `data-state` (open or closed); the selection
                    // is `data-selected`, with the tint of the registry's `selected` state.
                    data-selected={row.getIsSelected() || undefined}
                    aria-selected={selectable ? row.getIsSelected() : undefined}
                    className={cn(
                      "data-[selected=true]:[--row-mix:100%] data-[state=open]:[--row-mix:50%]",
                      onRowClick && "cursor-pointer",
                    )}
                    onClick={
                      onRowClick
                        ? (event) => {
                            // A control inside the row keeps its own click.
                            if (
                              (event.target as HTMLElement).closest(
                                "a,button,input,select,textarea,label,[role=menuitem],[role=checkbox]",
                              )
                            ) {
                              return;
                            }
                            onRowClick(row.original);
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <BodyCell key={cell.id} cell={cell} />
                    ))}
                  </TableRow>
                </RowContextMenu>
              ))
            ) : state === "loading" ? (
              Array.from({ length: skeletonRows }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                <TableRow key={index} aria-hidden="true" className={PLACEHOLDER_ROW}>
                  {visibleColumns.map((column) => {
                    const meta = column.columnDef.meta;
                    const pin = columnPin(column);
                    return (
                      <TableCell
                        key={column.id}
                        pin={pin}
                        style={pin ? undefined : widthStyle(declaredWidths(column))}
                        className={cn(meta?.className, meta?.cellClassName)}
                      >
                        {column.id === "actions" || column.id === SELECT_COLUMN_ID ? null : (
                          <Skeleton
                            className={cn(
                              "h-4",
                              meta?.numeric ? "ml-auto w-12" : "w-full max-w-40",
                            )}
                          />
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={Math.max(1, visibleColumns.length)}
                  className="p-4 whitespace-normal"
                >
                  {/* The message stays in view of the scrolling container, not centred in a row as wide as the columns. */}
                  <div className="sticky left-4 w-[calc(100cqw-2rem)] max-w-full">
                    {state === "error" ? (
                      <ErrorState
                        title={errorTitle ?? t("table.error.title")}
                        error={error}
                        onRetry={onRetry}
                        retrying={fetching}
                      />
                    ) : state === "filteredEmpty" ? (
                      (filteredEmpty ?? (
                        <EmptyState
                          variant="plain"
                          icon={SearchX}
                          title={t("table.filteredEmpty.title")}
                          description={t("table.filteredEmpty.description")}
                          actions={
                            canReset ? (
                              <Button variant="outline" size="sm" onClick={resetFilters}>
                                {t("table.filteredEmpty.reset")}
                              </Button>
                            ) : null
                          }
                        />
                      ))
                    ) : (
                      (empty ?? (
                        <EmptyState
                          variant="plain"
                          icon={Inbox}
                          title={t("table.empty.title")}
                          description={t("table.empty.description")}
                        />
                      ))
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pagination?.mode === "loadMore" && state === "rows" ? (
        <DataTableLoadMore
          count={rows.length}
          hasMore={pagination.hasMore}
          loadingMore={pagination.loadingMore}
          onLoadMore={pagination.onLoadMore}
        />
      ) : paginated && state === "rows" ? (
        <DataTablePagination table={table} pageSizes={pagination.pageSizes} />
      ) : null}
    </div>
  );
}

const SELECT_COLUMN_ID = "select";

/** The checkbox column of a `selectable` table: the page's rows in the header, one row per cell. */
function selectionColumn<TData>(
  name: ((row: TData) => string) | undefined,
): ColumnDef<TData, unknown> {
  return {
    id: SELECT_COLUMN_ID,
    size: 40,
    enableSorting: false,
    enableHiding: false,
    enableGlobalFilter: false,
    meta: { className: "w-10" },
    header: ({ table }) => <SelectPageBox table={table} />,
    cell: ({ row }) => <SelectRowBox row={row} name={name?.(row.original)} />,
  };
}

function SelectPageBox<TData>({ table }: { table: TanstackTable<TData> }) {
  const { t } = useTranslation(UI_NAMESPACE);
  const all = table.getIsAllPageRowsSelected();
  const some = table.getIsSomePageRowsSelected();
  return (
    <Checkbox
      checked={all ? true : some ? "indeterminate" : false}
      onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
      disabled={table.getRowModel().rows.length === 0}
      aria-label={t("table.selection.selectPage")}
      className="align-middle"
    />
  );
}

function SelectRowBox<TData>({ row, name }: { row: Row<TData>; name: string | undefined }) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <Checkbox
      checked={row.getIsSelected()}
      onCheckedChange={(value) => row.toggleSelected(value === true)}
      disabled={!row.getCanSelect()}
      aria-label={name ? t("table.selection.selectRow", { name }) : t("table.selection.select")}
      className="align-middle"
    />
  );
}

/** Above a table with selected rows: how many, what can be done with them, and a way out. */
function SelectionBar({
  count,
  actions,
  onClear,
}: {
  count: number;
  actions: readonly RowAction[];
  onClear: () => void;
}) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <div
      data-slot="data-table-selection"
      className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{t("table.selection.count", { count })}</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-muted-foreground"
          onClick={onClear}
        >
          {t("table.selection.clear")}
        </Button>
      </div>
      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <SelectionActionButton key={action.id} action={action} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SelectionActionButton({ action }: { action: RowAction }) {
  const Icon = action.icon;
  const variant = action.destructive ? "destructive" : "outline";
  const content = (
    <>
      {Icon ? <Icon aria-hidden="true" /> : null}
      {action.label}
    </>
  );
  if (action.link && !action.disabled) {
    return (
      <Button asChild variant={variant} size="sm" data-action={action.id}>
        <Link to={action.link.to} search={action.link.search as never} onClick={action.onSelect}>
          {content}
        </Link>
      </Button>
    );
  }
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={action.disabled}
      aria-describedby={action.describedBy}
      title={action.disabled ? action.reason : undefined}
      onClick={action.onSelect}
      data-action={action.id}
    >
      {content}
    </Button>
  );
}

function HeaderCell<TData>({ header }: { header: Header<TData, unknown> }) {
  const { t } = useTranslation(UI_NAMESPACE);
  const column = header.column;
  const meta = column.columnDef.meta;
  const content = header.isPlaceholder
    ? null
    : flexRender(column.columnDef.header, header.getContext());
  const canSort = column.getCanSort();
  const sorted = column.getIsSorted();
  const SortIcon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
  const name = columnLabel(column);
  const pin = columnPin(column);

  return (
    <TableHead
      aria-sort={ariaSortFor(canSort, sorted)}
      pin={pin}
      style={pin ? undefined : widthStyle(declaredWidths(column))}
      className={cn(
        "sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--color-border)]",
        // The pinned header is the corner: sticky in both directions and above
        // the other header cells, which scroll under it sideways.
        pin && "z-20 max-sm:sticky",
        meta?.numeric && "text-right whitespace-nowrap",
        meta?.className,
        meta?.headerClassName,
      )}
    >
      {canSort ? (
        <button
          type="button"
          onClick={column.getToggleSortingHandler()}
          aria-label={name ? t("table.sortBy", { column: name }) : undefined}
          className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {content}
          <SortIcon
            aria-hidden="true"
            className={cn("size-3.5 shrink-0", sorted ? "opacity-100" : "opacity-40")}
          />
        </button>
      ) : (
        content
      )}
    </TableHead>
  );
}

/**
 * A body cell: pinned when its column is, with the width its column declared.
 * A pinned column and one with a `maxSize` hold a single line: the content
 * is cut off with an ellipsis inside the cell (the clip sits on an inner box
 * with room for focus rings, because the cell itself casts the pinned edge's
 * shadow) and says what it is in a tooltip.
 */
function BodyCell<TData>({ cell }: { cell: Cell<TData, unknown> }) {
  const column = cell.column;
  const meta = column.columnDef.meta;
  const pin = columnPin(column);
  const widths = declaredWidths(column);
  const truncates = pin !== undefined || widths.max !== undefined;
  const content = flexRender(column.columnDef.cell, cell.getContext());
  const title = truncates
    ? truncatedTitle(
        cell.getValue(),
        column.columnDef.cell === plainCell,
        meta?.cellTitle?.(cell.row.original),
      )
    : undefined;

  return (
    <TableCell
      pin={pin}
      style={pin ? undefined : widthStyle(widths)}
      className={cn(
        meta?.numeric && "text-right whitespace-nowrap tabular-nums",
        meta?.className,
        meta?.cellClassName,
      )}
    >
      {truncates ? (
        <div
          title={title}
          className="-mx-1 -my-1 overflow-hidden px-1 py-1 text-ellipsis whitespace-nowrap"
        >
          {content}
        </div>
      ) : (
        content
      )}
    </TableCell>
  );
}
