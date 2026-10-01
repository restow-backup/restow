import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Info,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import type * as React from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The six status tones every page uses; each maps to a badge variant.
 *
 * Green (`success`) is reserved for proof (brand guide, section 4): a restore
 * check that passed ("Ready", "Verified"), a restore that completed, a storage
 * or hash chain check that came back intact. A backup that merely completed, an
 * object that is protected, a machine that is online or a member who is active
 * is `neutral` (an outline in the text colour); something running, or news that
 * asks for nothing, is `info` (Lapis); `muted` is for what is switched off or
 * unknown. Only real problems are `warning` or `destructive`.
 */
export type StatusTone = "success" | "warning" | "destructive" | "muted" | "info" | "neutral";

/** The standard icon of each tone, used by `icon={true}`. */
export const STATUS_TONE_ICON: Readonly<Record<StatusTone, LucideIcon>> = {
  success: CircleCheck,
  warning: TriangleAlert,
  destructive: CircleX,
  muted: CircleDashed,
  info: Info,
  neutral: Circle,
};

const DOT_CLASS: Readonly<Record<StatusTone, string>> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
  info: "bg-info",
  neutral: "bg-foreground",
};

/** The badge variant of each tone: every tone has its own, `neutral` is the outline. */
const BADGE_VARIANT: Readonly<Record<StatusTone, NonNullable<BadgeProps["variant"]>>> = {
  success: "success",
  warning: "warning",
  destructive: "destructive",
  muted: "muted",
  info: "info",
  neutral: "outline",
};

export interface StatusBadgeProps extends Omit<React.ComponentProps<"span">, "children"> {
  tone: StatusTone;
  /** The status in words; colour alone never carries the meaning. */
  children: React.ReactNode;
  /** An icon before the label; `true` picks the tone's standard icon. */
  icon?: LucideIcon | boolean;
  /** Something is running right now: a pulsing dot replaces the icon. */
  live?: boolean;
}

/**
 * A status label in one of six tones (success, warning, destructive, muted,
 * info, neutral), optionally with an icon or a live pulse for running work.
 * The text uses each tone's text-safe token, so it stays readable in light and
 * dark.
 */
export function StatusBadge({
  tone,
  children,
  icon,
  live = false,
  className,
  ...props
}: StatusBadgeProps) {
  const Icon = icon === true ? STATUS_TONE_ICON[tone] : icon || null;
  return (
    <Badge variant={BADGE_VARIANT[tone]} data-tone={tone} className={className} {...props}>
      {live ? (
        <span aria-hidden="true" className="relative flex size-2 shrink-0">
          <span
            className={cn(
              "absolute inline-flex size-full rounded-full opacity-75 motion-safe:animate-ping",
              DOT_CLASS[tone],
            )}
          />
          <span className={cn("relative inline-flex size-2 rounded-full", DOT_CLASS[tone])} />
        </span>
      ) : Icon ? (
        <Icon aria-hidden="true" />
      ) : null}
      {children}
    </Badge>
  );
}
