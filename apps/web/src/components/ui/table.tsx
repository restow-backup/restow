import { cn } from "cn";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { useScrollEdges } from "@/lib/use-scroll-edges";

/**
 * A column pinned to the left edge of a table that scrolls sideways. Pass it
 * to `TableHead` and `TableCell` of that column; the kit's DataTable builds
 * it from TanStack Table's column pinning.
 */
export interface TablePin {
  /**
   * Distance from the left edge in pixels: 0 for the first pinned column, the
   * summed widths of the pinned columns before it for the next one (give those
   * columns a fixed width).
   */
  left: number;
  /**
   * Fixed width of the pinned column in pixels. The kit's DataTable passes
   * it so the offsets of later pinned columns add up; on phones the column
   * keeps at most 45 % of the screen. Without it the column keeps its
   * natural width (up to 45 % of the screen on phones).
   */
  width?: number;
  /**
   * The last pinned column casts the edge shadow once the table is scrolled.
   * With several pinned columns, the first one carries `"narrow"`: on phones
   * only that column pins, so only there its edge shows.
   */
  edge?: boolean | "narrow";
}

/** The first column pinned on its own: the common case. */
export const PIN_FIRST: TablePin = { left: 0, edge: true };

/*
 * Sticky cells must be opaque, or the columns scrolling underneath show
 * through. The surface behind the table is the card (`--table-surface`
 * overrides it for a table on another surface, e.g. inside a dialog). A row
 * tints itself through `--row-mix` (0 % at rest, 50 % hovered or expanded,
 * 100 % selected, see `TableRow`); the pinned cell mixes the same share of
 * `--muted` into the opaque surface, so it matches its row in every state, in
 * light and dark, and under any colour scheme (all of them are tokens).
 * The class names are spelled out in full: Tailwind finds them as plain text.
 */
const PIN_HEAD_SURFACE = "bg-[color:var(--table-surface,var(--card))]";
const PIN_CELL_SURFACE =
  "bg-[color-mix(in_oklab,var(--muted)_var(--row-mix,0%),var(--table-surface,var(--card)))] transition-colors motion-reduce:transition-none";

/** Fixed width of a pinned column (`TablePin.width`), clamped on phones. */
const PIN_WIDTH =
  "sm:w-(--pin-w) sm:max-w-(--pin-w) sm:min-w-(--pin-w) max-sm:w-[min(var(--pin-w),45vw)] max-sm:max-w-[min(var(--pin-w),45vw)] max-sm:min-w-[min(var(--pin-w),45vw)]";

/**
 * Edge shadow of the last pinned column: a soft gradient to the right of the
 * cell, visible once the container is scrolled (`data-scrolled` on
 * `table-container`). It fades with `motion-safe` only.
 */
const PIN_EDGE =
  "after:pointer-events-none after:absolute after:-top-px after:-bottom-px after:left-full after:w-3 after:bg-linear-to-r after:from-black/10 after:to-transparent after:opacity-0 after:content-[''] dark:after:from-black/40 motion-safe:after:transition-opacity group-data-[scrolled=true]/scroll:after:opacity-100";

/**
 * Classes and inline style of a pinned header or body cell. On phones only
 * the first pinned column pins (further ones scroll along) and at most 45 %
 * of the screen is kept for it, so a wide name column never covers the data
 * it labels.
 */
export function pinnedCell(
  pin: TablePin,
  kind: "head" | "cell",
  style?: React.CSSProperties,
): { className: string; style: React.CSSProperties } {
  return {
    className: cn(
      pin.left === 0 ? "sticky" : "max-sm:static sm:sticky",
      kind === "cell" ? "z-5" : "z-6",
      pin.width === undefined ? "max-sm:max-w-[45vw]" : PIN_WIDTH,
      kind === "cell" ? PIN_CELL_SURFACE : PIN_HEAD_SURFACE,
      pin.edge && PIN_EDGE,
      pin.edge === "narrow" && "sm:after:hidden",
      pin.edge === true && pin.left !== 0 && "max-sm:after:hidden",
    ),
    style: {
      left: pin.left,
      ...(pin.width === undefined ? {} : { "--pin-w": `${pin.width}px` }),
      ...style,
    } as React.CSSProperties,
  };
}

interface TableProps extends React.ComponentProps<"table"> {
  /** Classes for the scroll container around the table. */
  containerClassName?: string;
  /**
   * Accessible name of the scroll container, which becomes a keyboard stop
   * (a region) while the table scrolls. Usually the name of the table.
   */
  scrollLabel?: string;
}

/**
 * The table and the container it scrolls in: sideways when the columns do not
 * fit (the page itself never scrolls sideways), and vertically when the
 * container has a height cap. While it scrolls, the container is a labelled
 * region that the keyboard reaches (arrow keys scroll it), carries
 * `data-scrolled` (moved away from the left edge) and `data-more` (more to the
 * right) for the pinned-column shadow, and fades out on the right as long as
 * more follows. The table semantics inside stay as they are.
 */
function Table({ className, containerClassName, scrollLabel, ...props }: TableProps) {
  const { t } = useTranslation();
  const { ref, scrolled, more, scrollable, inset } = useScrollEdges<HTMLDivElement>();
  const name = scrollLabel?.trim();
  return (
    <div
      ref={ref}
      data-slot="table-container"
      data-scrolled={scrolled ? "true" : "false"}
      data-more={more ? "true" : "false"}
      role={scrollable ? "region" : undefined}
      tabIndex={scrollable ? 0 : undefined}
      aria-label={
        scrollable
          ? name
            ? t("table.scrollable", { name })
            : t("table.scrollableUnnamed")
          : undefined
      }
      // Keyboard focus scrolls a control into view beside the pinned columns, not underneath.
      style={inset > 0 ? { scrollPaddingLeft: inset } : undefined}
      className={cn(
        "group/scroll relative w-full overflow-x-auto overscroll-x-contain",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
        "data-[more=true]:[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_2rem),transparent)] data-[more=true]:[mask-image:linear-gradient(to_right,#000_calc(100%_-_2rem),transparent)]",
        containerClassName,
      )}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b bg-[color-mix(in_oklab,var(--muted)_var(--row-mix),transparent)] transition-colors [--row-mix:0%] hover:[--row-mix:50%] has-aria-expanded:[--row-mix:50%] data-[state=selected]:[--row-mix:100%]",
        className,
      )}
      {...props}
    />
  );
}

/*
 * Unlike the registry, heads and cells wrap (no `whitespace-nowrap`): long
 * German labels, reasons and progress lines stay inside the card instead of
 * forcing a horizontal scroll. A column that must stay on one line (times,
 * sizes, actions) says `whitespace-nowrap` itself.
 */
function TableHead({
  className,
  style,
  pin,
  ...props
}: React.ComponentProps<"th"> & { pin?: TablePin }) {
  const pinned = pin ? pinnedCell(pin, "head", style) : null;
  return (
    <th
      data-slot="table-head"
      data-pinned={pin ? "left" : undefined}
      className={cn(
        "h-10 px-2 text-left align-middle font-medium text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        pinned?.className,
        className,
      )}
      style={pinned ? pinned.style : style}
      {...props}
    />
  );
}

function TableCell({
  className,
  style,
  pin,
  ...props
}: React.ComponentProps<"td"> & { pin?: TablePin }) {
  const pinned = pin ? pinnedCell(pin, "cell", style) : null;
  return (
    <td
      data-slot="table-cell"
      data-pinned={pin ? "left" : undefined}
      className={cn(
        "p-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        pinned?.className,
        className,
      )}
      style={pinned ? pinned.style : style}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
