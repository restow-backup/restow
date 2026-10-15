import * as React from "react";

/**
 * Whether the person asked the system for less motion (`prefers-reduced-motion: reduce`). CSS
 * covers what it animates with `motion-safe:` and `motion-reduce:`; this is for motion driven
 * from script (a chart that slides, a number that counts up), which CSS cannot switch off.
 * Follows a change of the setting while the page is open.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

function subscribe(listener: () => void): () => void {
  const list = media();
  if (!list) {
    return () => undefined;
  }
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}

function snapshot(): boolean {
  return media()?.matches ?? false;
}

export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}
