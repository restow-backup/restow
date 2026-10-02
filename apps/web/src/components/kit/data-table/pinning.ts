import type { Column, ColumnPinningState } from "@tanstack/react-table";
import type * as React from "react";

import type { TablePin } from "@/components/ui/table";

/**
 * TanStack's column pinning state for the ids a page pins to the left. Ids
 * that are not columns, or hidden ones, are ignored by TanStack itself.
 */
export function pinningState(ids: readonly string[] | undefined): ColumnPinningState {
  return { left: ids ? [...ids] : [], right: [] };
}

/**
 * The pin of a column for the shared table cells, or `undefined` when it is
 * not pinned. `left` comes from TanStack (`column.getStart('left')`: the
 * widths of the pinned columns in front, so one, two or more columns line up),
 * and the width of the column is its `size`, which is also what `getStart`
 * adds up, so pinned columns need a `size` that suits their content.
 */
export function columnPin<TData>(column: Column<TData, unknown>): TablePin | undefined {
  if (column.getIsPinned() !== "left") {
    return undefined;
  }
  const last = column.getIsLastColumn("left");
  const first = column.getIsFirstColumn("left");
  return {
    left: column.getStart("left"),
    width: column.getSize(),
    edge: last ? true : first ? "narrow" : undefined,
  };
}

/** What a column declares about its width (`size`, `minSize`, `maxSize` of the column def). */
export interface ColumnWidths {
  /** The cell never gets narrower than this many pixels. */
  min?: number;
  /** The cell never gets wider than this many pixels; its text is cut off with an ellipsis. */
  max?: number;
}

/**
 * Widths a column declared. A column without a `size` or `minSize` stays
 * automatic; one with either gets that as its minimum, so the table keeps
 * the sum of its visible columns instead of squeezing them into wrapped
 * text, and scrolls inside its container when that does not fit. A column
 * can be hidden by a responsive class (`hidden md:table-cell`): its cells do
 * not take part in the layout then, so the minimum follows what is shown.
 * `maxSize` caps the column and turns it into a single, truncated line.
 */
export function declaredWidths<TData>(column: Column<TData, unknown>): ColumnWidths {
  const def = column.columnDef;
  const min = def.minSize ?? def.size;
  const max = def.maxSize !== undefined && Number.isFinite(def.maxSize) ? def.maxSize : undefined;
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

/** Inline style for the cells of an unpinned column from its declared widths. */
export function widthStyle(widths: ColumnWidths): React.CSSProperties | undefined {
  if (widths.min === undefined && widths.max === undefined) {
    return undefined;
  }
  return { minWidth: widths.min, maxWidth: widths.max };
}

/**
 * The tooltip of a truncated cell: what the page said in `meta.cellTitle`, or
 * else the cell's own text when the column renders its value as plain text. A
 * cell that renders elements (a link, badges) titles its own content.
 */
export function truncatedTitle(
  value: unknown,
  plain: boolean,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  return plain && (typeof value === "string" || typeof value === "number")
    ? String(value)
    : undefined;
}
