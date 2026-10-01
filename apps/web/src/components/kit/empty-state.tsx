import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  /** One sentence: why it is empty or what will appear here. */
  description?: string;
  /** The way forward (usually one button). */
  actions?: React.ReactNode;
  /** Same as `actions`; kept so the older restore empty state swaps in unchanged. */
  children?: React.ReactNode;
  /** `dashed` frames the state on a page; `plain` sits inside a table or card. */
  variant?: "dashed" | "plain";
  className?: string;
}

/** A calm, explicit "nothing here" with the reason and a way forward. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
  children,
  variant = "dashed",
  className,
}: EmptyStateProps) {
  const hasActions = Boolean(actions) || Boolean(children);
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        variant === "dashed" && "rounded-lg border border-dashed border-border",
        className,
      )}
    >
      <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {hasActions ? (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {actions}
          {children}
        </div>
      ) : null}
    </div>
  );
}
