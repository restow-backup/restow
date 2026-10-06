import type * as React from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface DisabledReasonProps {
  /** Why the control is unavailable; without it the child renders alone. */
  reason: React.ReactNode;
  /** The disabled control (a button, a select trigger). */
  children: React.ReactElement;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
}

/**
 * Shows why a control is disabled. A disabled button has
 * `pointer-events-none` and cannot take focus, so neither `title` nor a
 * tooltip on the button itself ever appears. The reason sits on a focusable
 * wrapper instead and is also exposed to screen readers.
 */
export function DisabledReason({ reason, children, side }: DisabledReasonProps) {
  if (reason === null || reason === undefined || reason === false || reason === "") {
    return children;
  }
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the wrapper carries the reason for a control that cannot take focus itself */}
          <span tabIndex={0} className="inline-flex cursor-not-allowed" data-slot="disabled-reason">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side={side} className="max-w-xs">
          {reason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
