import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * How a CardFlow places its cards.
 *
 * - `rows`: two columns from 42rem, row by row, for cards of about the same height (charts with
 *   the same plot height). Every card keeps its own height (`items-start`), nothing is stretched
 *   to its neighbour; an odd card at the end takes the whole row instead of leaving an empty cell.
 * - `columns`: two columns from 42rem that fill from the top, each card straight under the one
 *   before it, for cards of very different height (a tall readiness card beside a short last
 *   backup and price card). The browser balances the columns (CSS multi-column with
 *   `break-inside: avoid`), so a short card does not leave a hole beside a tall one.
 * - `stack`: one card below the other across the whole width, for two cards of very different
 *   height, where side by side the short one would leave a hole as tall as the difference.
 * - `tiles`: key figures of equal size in a regular grid (they do stretch to one height, as they
 *   hold the same parts). Two columns from 26rem, then `tileColumns` from 48rem (three) or 56rem
 *   (four); while there are two columns an odd tile at the end takes the whole row.
 *
 * Under 42rem (26rem for tiles) every layout is one column, in DOM order.
 *
 * Why CSS columns and not a split into column stacks in the markup: a split fixed in the markup
 * cannot balance (the heights are only known in the browser), would need measuring with
 * JavaScript (and layout shifts while charts load), and would change the order on a phone. CSS
 * columns keep one DOM order everywhere: it is the order on a phone, the keyboard and screen
 * reader order, and on a wide page the reading order down the first column, then the second.
 * Callers order their cards so that this reads well (most important first).
 *
 * Cards are the flow's direct children, without wrappers of the flow's own: a card that has
 * nothing to show renders nothing (null), and the layout rules (`:last-child`, `:only-child`,
 * `:nth-child`) count only what is rendered, so the rest reflows without a hole.
 *
 * The column count follows the flow's own width (a container query), so a collapsed sidebar
 * counts, wherever the flow sits.
 */
export type CardFlowLayout = "rows" | "columns" | "stack" | "tiles";

export interface CardFlowProps extends React.HTMLAttributes<HTMLElement> {
  layout?: CardFlowLayout;
  /** Most tile columns on a wide page (`tiles` only; default 3). */
  tileColumns?: 2 | 3 | 4;
  /** The element of the flow itself (default `div`). */
  as?: "div" | "section" | "ul";
}

/** The classes of each layout. Static strings, so Tailwind finds every one. */
export const CARD_FLOW_CLASS: Readonly<Record<CardFlowLayout, string>> = {
  rows: cn(
    "grid grid-cols-1 items-start gap-4 *:min-w-0",
    "@[42rem]/card-flow:grid-cols-2",
    "@[42rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-2",
  ),
  columns: cn(
    "*:mb-4 *:break-inside-avoid *:last:mb-0",
    "@[42rem]/card-flow:columns-2 @[42rem]/card-flow:gap-4",
    // A single card has the whole width, not one column beside an empty one.
    "*:only:[column-span:all]",
  ),
  stack: "grid grid-cols-1 gap-4 *:min-w-0",
  tiles: "grid grid-cols-1 gap-4 *:min-w-0 @[26rem]/card-flow:grid-cols-2",
};

/** The tile columns beyond two, by the most columns asked for. */
const TILE_COLUMNS_CLASS: Readonly<Record<2 | 3 | 4, string>> = {
  2: "@[26rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-2",
  3: cn(
    "@[26rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-2",
    "@[48rem]/card-flow:grid-cols-3 @[48rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-1",
  ),
  4: cn(
    "@[26rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-2",
    "@[56rem]/card-flow:grid-cols-4 @[56rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-1",
  ),
};

/** The classes of a flow's own element for a layout (exported for tests). */
export function cardFlowClass(layout: CardFlowLayout, tileColumns: 2 | 3 | 4 = 3): string {
  return cn(CARD_FLOW_CLASS[layout], layout === "tiles" && TILE_COLUMNS_CLASS[tileColumns]);
}

/**
 * Cards of a dashboard laid out without empty gaps: none is stretched to the height of its
 * neighbour, an odd card at the end takes the whole row, cards of different height fill their
 * columns from the top. See `CardFlowLayout` for the layouts.
 */
export function CardFlow({
  layout = "rows",
  tileColumns = 3,
  as: Element = "div",
  className,
  children,
  ...props
}: CardFlowProps) {
  return (
    // The container the column counts follow: the flow's own width.
    <div className="@container/card-flow">
      <Element
        data-slot="card-flow"
        data-layout={layout}
        className={cn(cardFlowClass(layout, tileColumns), className)}
        {...props}
      >
        {children}
      </Element>
    </div>
  );
}
