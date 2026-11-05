import type * as React from "react";

import { cn } from "@/lib/utils";

import {
  EMPTY_FILL_CLASS,
  EMPTY_ICON_CLASS,
  fillClass,
  STATUS_TEXT,
  type StatusMeta,
  toneOf,
} from "./status-meta.js";

/**
 * One segment of a status bar: solid in its tone, or hatched (Unverified). The bar itself is
 * `aria-hidden`; its legend carries the meaning in words. `width` is a share of the bar (0..1).
 */
export function StatusSegment({
  meta,
  width,
  className,
}: {
  meta: StatusMeta;
  width: number;
  className?: string;
}) {
  return (
    <div
      data-category={meta.id}
      data-severity={meta.severity}
      data-pattern={meta.pattern}
      className={cn("h-full", fillClass(meta), className)}
      style={{ width: `${Math.max(0, Math.min(1, width)) * 100}%` }}
    />
  );
}

/**
 * The icon of a status in its tone's text-safe colour, so a legend row, a tile or a chip never
 * relies on colour alone. `dimmed` (a category with nothing in it) draws it in the muted colour.
 */
export function StatusIcon({
  meta,
  dimmed = false,
  className,
}: {
  meta: StatusMeta;
  dimmed?: boolean;
  className?: string;
}) {
  const Icon = meta.icon;
  return (
    <Icon
      aria-hidden="true"
      data-category={meta.id}
      className={cn(
        "size-4 shrink-0",
        dimmed ? EMPTY_ICON_CLASS : STATUS_TEXT[toneOf(meta)],
        className,
      )}
    />
  );
}

/** A small square swatch of a status (solid or hatched); muted when `dimmed`. */
export function StatusSwatch({
  meta,
  dimmed = false,
  className,
}: {
  meta: StatusMeta;
  dimmed?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-category={meta.id}
      data-pattern={meta.pattern}
      className={cn(
        "size-2.5 shrink-0 rounded-[2px]",
        dimmed ? EMPTY_FILL_CLASS : fillClass(meta),
        className,
      )}
    />
  );
}

/** The ids of the chart patterns {@link ChartHatchDefs} defines. */
export const CHART_HATCH = {
  warning: "status-hatch-warning",
  destructive: "status-hatch-destructive",
} as const;

/**
 * SVG patterns for recharts bars: stripes in the chart warning or destructive colour, so a
 * hatched series (Unverified, No backup yet) stays apart from the solid one beside it without
 * relying on colour. Mount it once inside the chart's SVG and fill a bar with
 * `url(#status-hatch-warning)`.
 */
export function ChartHatchDefs(): React.ReactElement {
  return (
    <defs>
      {(
        [
          [CHART_HATCH.warning, "var(--chart-warning)"],
          [CHART_HATCH.destructive, "var(--chart-destructive)"],
        ] as const
      ).map(([id, colour]) => (
        <pattern
          key={id}
          id={id}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="6" stroke={colour} strokeWidth="4" />
        </pattern>
      ))}
    </defs>
  );
}
