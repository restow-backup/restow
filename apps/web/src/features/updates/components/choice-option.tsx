import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A selectable card inside a group of native radio buttons (the input is
 * visually hidden; the whole card is the label). Arrow keys move within the
 * group like any radio group.
 */
export function ChoiceOption({
  name,
  value,
  checked,
  onSelect,
  disabled = false,
  className,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        checked ? "border-primary ring-1 ring-ring" : "border-border hover:bg-accent",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
      />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary" : "border-input",
        )}
      >
        {checked ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">{children}</span>
    </label>
  );
}
