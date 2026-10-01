import type { Column, ColumnDef, Row, RowData } from "@tanstack/react-table";
import { Ellipsis, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { UI_NAMESPACE } from "../i18n.js";
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

/** One entry of a row's action menu. */
export interface RowAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Deletes, revokes or stops something; listed last, separated and in red. */
  destructive?: boolean;
  disabled?: boolean;
}

export interface RowActionsMenuProps {
  actions: readonly RowAction[];
  /** Name of the row for the trigger's label, "Actions for <name>". */
  name?: string;
}

/**
 * The "…" menu of a row. Destructive actions come last, after a separator;
 * they should open a ConfirmDialog rather than act at once.
 */
export function RowActionsMenu({ actions, name }: RowActionsMenuProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  if (actions.length === 0) {
    return null;
  }
  const regular = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);
  const label = name ? t("table.actions.openFor", { name }) : t("table.actions.open");

  const item = (action: RowAction) => {
    const Icon = action.icon;
    return (
      <DropdownMenuItem
        key={action.id}
        variant={action.destructive ? "destructive" : "default"}
        disabled={action.disabled}
        onSelect={action.onSelect}
      >
        {Icon ? <Icon aria-hidden="true" /> : null}
        {action.label}
      </DropdownMenuItem>
    );
  };

  return (
    // Not modal: a dialog opened from an item must not inherit the menu's pointer lock.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label}>
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {regular.map(item)}
        {regular.length > 0 && destructive.length > 0 ? <DropdownMenuSeparator /> : null}
        {destructive.map(item)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionsHeader() {
  const { t } = useTranslation(UI_NAMESPACE);
  return <span className="sr-only">{t("table.actions.column")}</span>;
}

export interface RowActionsColumnOptions<TData> {
  /** The actions of one row; an empty list renders no menu. */
  actions: (row: TData) => readonly RowAction[];
  /** Name of the row for the trigger's screen-reader label. */
  name?: (row: TData) => string;
}

/** A trailing column with each row's action menu (never sortable or hideable). */
export function rowActionsColumn<TData>({
  actions,
  name,
}: RowActionsColumnOptions<TData>): ColumnDef<TData, unknown> {
  return {
    id: "actions",
    header: () => <ActionsHeader />,
    cell: ({ row }) => (
      <RowActionsMenu actions={actions(row.original)} name={name?.(row.original)} />
    ),
    enableSorting: false,
    enableHiding: false,
    meta: { className: "w-12 text-right" },
  };
}
