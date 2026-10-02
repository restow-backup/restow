import { Loader2, Radio, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import "../i18n";
import { ageStep } from "./age";
import { useSecondClock } from "./clock";
import { useLiveState } from "./provider";

/**
 * Whether the page is moving on its own, said plainly: "Live" with how long ago the server last
 * spoke, "Connecting", or, when the connection is lost, "Not connected, retrying" (and the pages
 * poll more slowly meanwhile). It is the one indicator of the one connection of the tab and
 * sits in the top bar; nothing shows where the channel is off (a tab in the background, "All
 * tenants", a person who is not an administrator).
 *
 * The age counts up locally, once a second, without a request, and stays out of the live region
 * so a screen reader hears a change of state, not every second. A pulsing dot is the only motion,
 * and it stands still with reduced motion.
 */
export function LiveIndicator({ className }: { className?: string }) {
  const { t } = useTranslation("history");
  const state = useLiveState();
  const status = state?.status ?? null;
  const open = status === "open";
  // The clock only runs while there is an age to show.
  const now = useSecondClock(open);
  if (state === null || status === null || status === "paused") {
    return null;
  }
  const closed = status === "closed";
  const retrying = status === "reconnecting";
  const age = state.lastActivityAt === null ? null : ageStep(now - state.lastActivityAt);
  const hint = closed
    ? "live.closedHint"
    : retrying
      ? "live.reconnectingHint"
      : open
        ? "live.openHint"
        : "live.connectingHint";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-slot="live-indicator"
          data-status={status}
          aria-label={t("live.label")}
          className={cn(
            "inline-flex h-8 cursor-default items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            open && "text-info-text",
            (closed || retrying) && "text-warning-foreground dark:text-warning",
            !open && !closed && !retrying && "text-muted-foreground",
            className,
          )}
        >
          {open ? (
            <span aria-hidden="true" className="relative flex size-2">
              <span className="absolute inline-flex size-full rounded-full bg-info opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex size-2 rounded-full bg-info" />
            </span>
          ) : closed ? (
            <WifiOff aria-hidden="true" className="size-3.5" />
          ) : retrying ? (
            <Loader2 aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
          ) : (
            <Radio aria-hidden="true" className="size-3.5" />
          )}
          {/* A phone has room for the word "Live" only; the longer states keep their icon and say the rest to a screen reader. */}
          <output aria-live="polite" className={cn(!open && "sr-only sm:not-sr-only")}>
            {t(`live.${status}`)}
          </output>
          {open && age ? (
            <span className="hidden font-normal text-muted-foreground tabular-nums md:inline">
              {t(`live.updated.${age.unit}`, "count" in age ? { count: age.count } : undefined)}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{t(hint)}</TooltipContent>
    </Tooltip>
  );
}
