import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One section of the job editor: a card with its own heading, so that a group of
 * settings (the folders, the bandwidth limit, ...) can grow or be joined by
 * another later without moving what is around it.
 */
export function EditorSection({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const titleId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-slot="editor-section"
      className={cn("space-y-4 rounded-lg border bg-card p-4 text-card-foreground", className)}
    >
      <header className="space-y-1">
        <h3 id={titleId} className="text-sm leading-none font-semibold">
          {title}
        </h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
