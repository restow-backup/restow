import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The small dot that says "an update is available": the info (accent) colour, never green,
 * because a new release is news and not proof of anything. It breathes gently unless the person
 * asked for reduced motion (`motion-safe:`). The dot is decorative; the place that carries it
 * says the same in words ("Update to x.y.z available") for assistive technology.
 */
export function UpdateDot({
  className,
  ...props
}: { className?: string } & Omit<React.ComponentProps<"span">, "className">) {
  return (
    <span
      aria-hidden="true"
      data-slot="update-dot"
      {...props}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full bg-info motion-safe:animate-update-pulse",
        className,
      )}
    />
  );
}
