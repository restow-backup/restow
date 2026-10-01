import type { LucideIcon } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";

import { HintTooltip, type HintTooltipProps } from "./hint-tooltip.js";

export interface IconButtonProps extends Omit<ButtonProps, "children" | "size" | "asChild"> {
  icon: LucideIcon;
  /** Accessible name, also the tooltip unless `tooltip` says otherwise. */
  label: string;
  tooltip?: string;
  size?: "icon" | "icon-xs" | "icon-sm" | "icon-lg";
  iconClassName?: string;
  side?: HintTooltipProps["side"];
}

/** An icon-only button that always has a name and shows it as a tooltip. */
export function IconButton({
  icon: Icon,
  label,
  tooltip,
  size = "icon-sm",
  variant = "ghost",
  iconClassName,
  side,
  ...props
}: IconButtonProps) {
  return (
    <HintTooltip content={tooltip ?? label} side={side}>
      <Button variant={variant} size={size} aria-label={label} {...props}>
        <Icon aria-hidden="true" className={iconClassName} />
      </Button>
    </HintTooltip>
  );
}
