import { cn } from "cn";
import { Progress as ProgressPrimitive } from "radix-ui";
import type * as React from "react";

/**
 * A determinate progress bar, or an indeterminate one without a `value`. The
 * value goes to the Radix root, which is what sets `role="progressbar"` with
 * `aria-valuenow`, `aria-valuemin` and `aria-valuemax`; without it a screen
 * reader announces a bar with no number. A value outside the range is clamped
 * (Radix would drop it and report the bar as indeterminate).
 */
function Progress({
  className,
  value,
  max = 100,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const current =
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : null;
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={current}
      max={max}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - ((current ?? 0) / max) * 100}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
