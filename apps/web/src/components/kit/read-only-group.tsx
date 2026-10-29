import * as React from "react";

import { cn } from "@/lib/utils";

/** Whether the nearest ReadOnlyGroup (or one around it) closes its controls. */
const ReadOnlyContext = React.createContext(false);

/**
 * Whether the content renders inside a closed ReadOnlyGroup. Content that a
 * portal moves out of the group's fieldset (a panel shown elsewhere on the
 * page) is no longer closed by it; it wraps itself in a ReadOnlyGroup with
 * this value instead.
 */
export function useReadOnlyGroup(): boolean {
  return React.useContext(ReadOnlyContext);
}

/**
 * Closes every control inside (a native disabled fieldset), so that a form
 * stays visible but cannot be changed. The fieldset is a plain block without
 * border or padding, and its vertical margin is left to the page's rhythm
 * (`space-y-*` on the parent spaces it like any other child); pass `className` where the group
 * should lay out its own children, for example with a gap. Links stay usable:
 * looking around is what a read-only viewer is there for. A group inside a
 * closed group is closed as well (natively, and in `useReadOnlyGroup`).
 */
export function ReadOnlyGroup({
  closed,
  className,
  children,
}: {
  closed: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const outer = React.useContext(ReadOnlyContext);
  const shut = closed || outer;
  return (
    <ReadOnlyContext.Provider value={shut}>
      <fieldset
        disabled={closed}
        className={cn("mx-0 block min-w-0 border-0 p-0", className)}
        data-read-only={closed ? "true" : undefined}
      >
        {children}
      </fieldset>
    </ReadOnlyContext.Provider>
  );
}
