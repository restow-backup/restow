import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Closes every control inside (a native disabled fieldset), so that a form
 * stays visible but cannot be changed. The fieldset is a plain block without
 * border or padding, and its vertical margin is left to the page's rhythm
 * (`space-y-*` on the parent spaces it like any other child); pass `className` where the group
 * should lay out its own children, for example with a gap. Links stay usable:
 * looking around is what a read-only viewer is there for.
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
  return (
    <fieldset
      disabled={closed}
      className={cn("mx-0 block min-w-0 border-0 p-0", className)}
      data-read-only={closed ? "true" : undefined}
    >
      {children}
    </fieldset>
  );
}
