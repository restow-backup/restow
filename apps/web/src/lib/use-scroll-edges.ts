import * as React from "react";

/** What a scroll container shows of its content right now. */
export interface ScrollEdges {
  /** Scrolled away from the left edge: content sits under the pinned columns. */
  scrolled: boolean;
  /** More content follows to the right. */
  more: boolean;
  /** The content is larger than the container in either direction. */
  scrollable: boolean;
}

export const NO_SCROLL_EDGES: ScrollEdges = { scrolled: false, more: false, scrollable: false };

/** `ScrollEdges` plus how far the sticky columns reach into the container. */
interface MeasuredEdges extends ScrollEdges {
  inset: number;
}

const NO_MEASURE: MeasuredEdges = { ...NO_SCROLL_EDGES, inset: 0 };

/**
 * How far the pinned columns reach in from the left edge of the container, in
 * pixels (0 without any): the right edge of the last header cell that is
 * actually sticky right now (a second pinned column scrolls along on phones).
 * Keyboard focus is scrolled into view beside this inset, not underneath.
 */
export function pinnedInset(container: HTMLElement): number {
  let inset = 0;
  for (const cell of container.querySelectorAll<HTMLElement>('thead [data-pinned="left"]')) {
    if (getComputedStyle(cell).position !== "sticky") {
      continue;
    }
    inset = Math.max(inset, (Number.parseFloat(cell.style.left) || 0) + cell.offsetWidth);
  }
  return inset;
}

/** The measurements `computeScrollEdges` needs (the fields of an element). */
export interface ScrollMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight?: number;
  clientHeight?: number;
}

/** Fractional pixel sizes round differently per browser; a pixel of slack avoids flicker. */
const TOLERANCE = 1;

/**
 * Edge state of a horizontally scrolling container: `scrolled` as soon as it
 * left the start, `more` while content is cut off on the right. `scrollLeft`
 * is negative in right-to-left layouts, so its magnitude counts.
 */
export function computeScrollEdges(metrics: ScrollMetrics): ScrollEdges {
  const offset = Math.abs(metrics.scrollLeft);
  const more = offset + metrics.clientWidth < metrics.scrollWidth - TOLERANCE;
  const scrolled = offset > 0;
  const scrollableX = metrics.scrollWidth > metrics.clientWidth + TOLERANCE;
  const scrollableY =
    metrics.scrollHeight !== undefined &&
    metrics.clientHeight !== undefined &&
    metrics.scrollHeight > metrics.clientHeight + TOLERANCE;
  return { scrolled, more, scrollable: scrollableX || scrollableY || scrolled || more };
}

function sameEdges(a: MeasuredEdges, b: MeasuredEdges): boolean {
  return (
    a.scrolled === b.scrolled &&
    a.more === b.more &&
    a.scrollable === b.scrollable &&
    a.inset === b.inset
  );
}

/**
 * Tracks the edge state of a scroll container for the pinned-column shadow,
 * the fade on the right and the keyboard stop: listens to `scroll` and
 * watches the container and its content (the table) for size changes, so a
 * window resize, a column that appears or rows that arrive update it too.
 * Attach `ref` to the container.
 *
 * `inset` is how far the pinned columns reach in from the left (see
 * `pinnedInset`). Nothing here animates; the visual transitions are CSS and
 * switch off under `prefers-reduced-motion`.
 */
export function useScrollEdges<T extends HTMLElement = HTMLElement>(): ScrollEdges & {
  inset: number;
  ref: (node: T | null) => void;
} {
  const [node, setNode] = React.useState<T | null>(null);
  const [edges, setEdges] = React.useState<MeasuredEdges>(NO_MEASURE);

  React.useEffect(() => {
    if (!node) {
      setEdges((current) => (sameEdges(current, NO_MEASURE) ? current : NO_MEASURE));
      return;
    }
    // The inset is measured when the container or its table changes size, not
    // on every scroll event: it only moves with the layout.
    let inset = pinnedInset(node);
    const update = () => {
      const next = { ...computeScrollEdges(node), inset };
      setEdges((current) => (sameEdges(current, next) ? current : next));
    };
    const measure = () => {
      inset = pinnedInset(node);
      update();
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(node);
      for (const child of Array.from(node.children)) {
        observer.observe(child);
      }
    }
    return () => {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [node]);

  return { ...edges, ref: setNode };
}
