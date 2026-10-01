import type * as React from "react";

import { cn } from "@/lib/utils";

/** A compact label/value list for detail panels. */
export function Facts({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]",
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
