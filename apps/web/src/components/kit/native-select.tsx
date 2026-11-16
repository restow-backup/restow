import { cn } from "cn";
import type * as React from "react";

/**
 * The browser's own `<select>`, dressed like `Input`: the same height, border, dark-mode fill,
 * focus ring and `aria-invalid` state. Use it for short fixed lists inside forms where the
 * native picker is the better control (small screens, a handful of options, no search). The kit's
 * `Select` stays the choice for anything with a custom look or a long, searchable list.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        // The open list is drawn by the browser on the field's fill, which is see-through here.
        "[&>option]:bg-popover [&>option]:text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}
