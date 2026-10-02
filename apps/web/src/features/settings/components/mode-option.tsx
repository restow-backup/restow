import type * as React from "react";

import { cn } from "@/lib/utils";

interface ModeOptionProps {
  name: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

/** A selectable card inside a radio group (native radio, visually hidden). */
export function ModeOption({
  name,
  icon,
  title,
  description,
  selected,
  onSelect,
}: ModeOptionProps) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-2 rounded-lg border p-4 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70",
        selected
          ? "border-primary ring-1 ring-ring"
          : "border-border hover:bg-accent has-[:disabled]:hover:bg-transparent",
      )}
    >
      <input type="radio" name={name} className="sr-only" checked={selected} onChange={onSelect} />
      <span className="text-primary" aria-hidden="true">
        {icon}
      </span>
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </label>
  );
}
