import type * as React from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface HintTooltipProps {
  /** Tooltip text; without it the child renders alone. */
  content: React.ReactNode;
  /** One focusable element that accepts a ref (a button, a focusable time). */
  children: React.ReactElement;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
}

/**
 * A tooltip around one focusable element. It brings its own provider, so kit
 * parts also work outside the shell (setup wizard, sign-in pages).
 */
export function HintTooltip({ content, children, side }: HintTooltipProps) {
  if (content === null || content === undefined || content === "") {
    return children;
  }
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className="max-w-xs">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
