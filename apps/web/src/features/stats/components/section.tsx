import type * as React from "react";

import { cn } from "@/lib/utils";

interface StatsSectionProps {
  /** Unique id of the heading, for `aria-labelledby`. */
  id: string;
  title: string;
  /** Right-aligned next to the heading, for example an export menu. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * One part of the statistics page (key figures, trends, details) under a
 * heading, so the long page reads, and navigates by headings, in sections.
 */
export function StatsSection({ id, title, action, children, className }: StatsSectionProps) {
  return (
    <section aria-labelledby={id} className={cn("space-y-3", className)}>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {action}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
