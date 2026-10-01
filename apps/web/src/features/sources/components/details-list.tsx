import type * as React from "react";

import { cn } from "@/lib/utils";

/** A compact label/value list for connection facts. */
export function DetailsList({
  children,
  className,
}: { children: React.ReactNode; className?: string }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2", className)}>{children}</dl>
  );
}

export function DetailsItem({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
