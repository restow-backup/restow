import { useMutation } from "@tanstack/react-query";
import { Check, EyeOff, Minus, Rocket, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DisabledReason, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useSidebar } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type SetupItem, setMailNotNeeded } from "@/features/dashboard/api";
import { LinkButton } from "@/features/dashboard/components/link-button";
import { setupItemPath, to } from "@/features/dashboard/paths";
import { useInstallationAccess } from "@/features/installation/access";
import { errorMessageKey } from "@/lib/api";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import { notNeededOffer, readStartDismissed, writeStartDismissed } from "./presenters";
import { useStart } from "./use-start";
import "@/features/dashboard/i18n";

/**
 * "Start" in the sidebar footer, above the version: a rocket, how many steps of
 * the setup are done and a small ring. It opens a popover upwards with the steps
 * and, on each open one, the way to do it. When every step is done the entry is
 * gone, and a toast said so once. The ticks are the primary colour, not green:
 * green is the proof of a passed restore check, and a done step is only in order.
 * Collapsed, the sidebar keeps the rocket with the ring around it; in the phone
 * menu the entry sits at its bottom. Whoever does not want the guide hides it for
 * good from the popover ("Hide Start"); the steps stay on the tenant page, and the
 * toast that confirms it can bring the entry back.
 */
export function StartEntry() {
  const { t } = useTranslation("dashboard");
  const start = useStart();
  const userId = useSession().user?.id ?? null;
  const { state, isMobile, setOpenMobile } = useSidebar();
  const [open, setOpen] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(() =>
    userId ? readStartDismissed(userId) : false,
  );
  const collapsed = state === "collapsed" && !isMobile;

  // Another user signing in in the same tab reads their own choice.
  React.useEffect(() => {
    setDismissed(userId ? readStartDismissed(userId) : false);
  }, [userId]);

  const { view, setup } = start;
  if (!view || !setup || dismissed || !userId) {
    return null;
  }
  const progress = t("start.progress", { done: view.done, total: view.total });
  const label = t("start.label", { done: view.done, total: view.total });
  const close = () => {
    setOpen(false);
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const hide = (hidden: boolean) => {
    writeStartDismissed(userId, hidden);
    setDismissed(hidden);
  };
  const dismiss = () => {
    close();
    hide(true);
    toast.success(t("start.dismissed.toast"), {
      description: t("start.dismissed.description"),
      action: { label: t("start.dismissed.undo"), onClick: () => hide(false) },
    });
  };

  return (
    <div data-slot="start" data-done={view.done} data-total={view.total}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={label}
                className={cn(
                  "relative flex w-full items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-2 text-left outline-none transition-colors",
                  "hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50",
                  "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:rounded-lg"
                >
                  <Rocket className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight group-data-[collapsible=icon]:sr-only">
                  <span className="text-sm font-semibold">{t("start.title")}</span>
                  <span className="truncate text-xs text-muted-foreground">{progress}</span>
                </span>
                <ProgressRing
                  fraction={view.fraction}
                  className="group-data-[collapsible=icon]:hidden"
                />
                {/* Collapsed: the ring runs around the rocket instead of beside it. */}
                <ProgressRing
                  fraction={view.fraction}
                  size={32}
                  stroke={2.5}
                  className="pointer-events-none absolute inset-0 hidden group-data-[collapsible=icon]:block"
                />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" hidden={!collapsed || open}>
            {`${t("start.title")} · ${progress}`}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          collisionPadding={8}
          data-slot="start-popover"
          className="max-h-[min(40rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1rem))] overflow-y-auto p-1.5"
        >
          <div className="space-y-1.5 px-2.5 pt-2 pb-2">
            <p className="text-sm font-semibold">
              {t("start.popover.title", { name: start.tenantName })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("setup.progress", { done: setup.done, total: setup.total })}
            </p>
            <Progress value={Math.round(view.fraction * 100)} aria-label={progress} />
          </div>
          <ul className="space-y-0.5">
            {setup.items.map((item) => (
              <StartItem
                key={item.id}
                item={item}
                onNavigate={close}
                onChanged={start.invalidate}
              />
            ))}
          </ul>
          <div className="flex items-end justify-between gap-2 px-2.5 pt-2 pb-1.5">
            <p className="text-xs text-muted-foreground">{t("start.popover.footer")}</p>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              onClick={dismiss}
              data-slot="start-dismiss"
            >
              <EyeOff />
              {t("start.dismissed.action")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The ring beside the text: how far the setup is, in the primary colour. */
function ProgressRing({
  fraction,
  size = 22,
  stroke = 3,
  className,
}: {
  fraction: number;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const centre = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      data-slot="start-ring"
      className={cn("shrink-0 -rotate-90", className)}
    >
      <circle
        cx={centre}
        cy={centre}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-foreground/15"
      />
      <circle
        cx={centre}
        cy={centre}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(circumference * fraction).toFixed(2)} ${circumference.toFixed(2)}`}
        className="stroke-primary"
      />
    </svg>
  );
}

/** The mark in front of a step: ticked in the primary colour, dashed when not needed, a warning when it needs attention. */
function StepMark({ state }: { state: SetupItem["state"] }) {
  return (
    <span
      aria-hidden="true"
      data-slot="start-mark"
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
        state === "done" && "border-primary bg-primary text-primary-foreground",
        state === "not_needed" && "border-dashed border-muted-foreground/60 text-muted-foreground",
        state === "attention" && "border-warning text-warning-text",
        state === "open" && "border-border",
      )}
    >
      {state === "done" ? (
        <Check className="size-3" />
      ) : state === "not_needed" ? (
        <Minus className="size-3" />
      ) : state === "attention" ? (
        <TriangleAlert className="size-3" />
      ) : null}
    </span>
  );
}

function StartItem({
  item,
  onNavigate,
  onChanged,
}: {
  item: SetupItem;
  onNavigate: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation("dashboard");
  const settled = item.state === "done" || item.state === "not_needed";
  const hint = item.reason
    ? t(`setup.reasons.${item.reason}`, { defaultValue: "" })
    : item.state === "done"
      ? ""
      : t(`setup.items.${item.id}.hint`);
  const offer = notNeededOffer(item);

  const showAction = item.actionable && !settled;
  const showInformation = !item.actionable && !settled;
  const showNotNeeded = item.actionable && offer !== null;

  return (
    <li
      data-item={item.id}
      data-state={item.state}
      className="flex items-start gap-3 rounded-md px-2.5 py-1.5 hover:bg-accent/50"
    >
      <StepMark state={item.state} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p
            className={cn(
              "min-w-32 flex-1 text-sm font-medium",
              settled && "text-muted-foreground",
            )}
          >
            {t(`setup.items.${item.id}.label`)}
            <span className="sr-only"> ({t(`setup.state.${item.state}`)})</span>
          </p>
          {showAction || showInformation || showNotNeeded ? (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              {showAction ? (
                <LinkButton
                  to={to(setupItemPath(item.id))}
                  size="xs"
                  variant="outline"
                  onClick={onNavigate}
                >
                  {t(`setup.items.${item.id}.action`)}
                </LinkButton>
              ) : null}
              {showInformation ? (
                <StatusBadge tone="muted">
                  {t(item.id === "notificationMail" ? "setup.byProvider" : "setup.byAdmin")}
                </StatusBadge>
              ) : null}
              {showNotNeeded && offer ? (
                <NotNeededButton offer={offer} onChanged={onChanged} />
              ) : null}
            </div>
          ) : null}
        </div>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.state === "attention" ? (
              <span className="font-medium text-warning-text">{t("start.attention")} </span>
            ) : null}
            {hint}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * "Not needed" on the notification mail, and taking it back: an installation setting, so
 * it takes the Owner role of the provider team and is closed in the public demo.
 */
function NotNeededButton({
  offer,
  onChanged,
}: {
  offer: "mark" | "undo";
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation("dashboard");
  // The same rule as the installation pages: the owner role of the provider team, and not in the demo.
  const block = useInstallationAccess().change;
  const change = useMutation({
    mutationFn: () => setMailNotNeeded(offer === "mark"),
    onSuccess: async () => {
      await onChanged();
      toast.success(t(offer === "mark" ? "start.notNeeded.marked" : "start.notNeeded.unmarked"));
    },
    onError: (error) => toast.error(t(`common:${errorMessageKey(error)}`)),
  });
  const reason = block === null ? undefined : t(`start.notNeeded.${block}`);
  // A disabled button never shows its title: the reason sits on a focusable wrapper.
  return (
    <DisabledReason reason={reason}>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        loading={change.isPending}
        disabled={block !== null}
        aria-description={reason}
        onClick={() => change.mutate()}
      >
        {t(offer === "mark" ? "start.notNeeded.mark" : "start.notNeeded.undo")}
      </Button>
    </DisabledReason>
  );
}
