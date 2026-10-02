import { Link, useNavigate } from "@tanstack/react-router";
import { Bell, CheckCheck } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { installationSectionTo } from "@/features/installation/paths";
import type { BellList, BellNotification } from "@/features/reports/api";
import { useBell, useMarkBellRead, useReportsScope } from "@/features/reports/hooks";
import { REPORTS_PATH } from "@/features/reports/paths";
import { cn } from "@/lib/utils";

/**
 * Installation-level notifications for provider admins about updates
 * (`update.available`, `update.succeeded`, `update.failed`). They lead to
 * Settings, Updates instead of staying a line of text.
 */
/**
 * The text key of a notification. A red rating because the newest backup is
 * too old reads "Backup too old", not "Restore check failed" (the worker sets
 * `details.redReason`).
 */
export function bellEventKey(item: Pick<BellNotification, "event" | "details">): string {
  if (item.event === "verify.red" && item.details?.redReason === "outdated") {
    return "bellEvents.verify.redOutdated";
  }
  return `bellEvents.${item.event}`;
}

export function isUpdateEvent(event: string): boolean {
  return event.startsWith("update.");
}

const LEVEL_DOT: Record<BellNotification["level"], string> = {
  info: "bg-muted-foreground/60",
  warning: "bg-warning",
  error: "bg-destructive",
};

/**
 * How many of the unread notifications need attention (a warning or an error:
 * a failed job, a failed restore check). The server counts them over every
 * unread entry; a server that does not say gets the answer from the entries
 * the bell holds, which are the newest ones.
 */
export function unreadAttentionCount(
  bell: Pick<BellList, "items" | "unread" | "unreadAttention"> | undefined,
): number {
  if (!bell || bell.unread === 0) {
    return 0;
  }
  const counted =
    bell.unreadAttention ?? bell.items.filter((item) => !item.read && item.level !== "info").length;
  return Math.min(counted, bell.unread);
}

/**
 * The badge colour: red is kept for unread failures and warnings, so it keeps
 * its meaning. Unread information ("Restore completed", "Report sent") gets
 * the info tone (Lapis), which says "something new" without raising an alarm.
 */
export function bellBadgeClass(attention: number): string {
  return attention > 0 ? "bg-destructive text-white" : "bg-info text-info-foreground";
}

/**
 * The bell in the top bar: the newest notifications of the active tenant
 * (failed jobs, readiness changes, storage findings, ready reports) and how
 * many are unread. Opening it does not mark anything read; that is a click.
 * A provider administrator with no tenant open gets the bell too, with the
 * installation-level notifications (an update is available or finished), and
 * without the link to the tenant's report rules.
 */
export function NotificationBell() {
  const { t } = useTranslation("reports");
  const scope = useReportsScope();
  const bell = useBell();
  const markRead = useMarkBellRead();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  if (!scope.enabled && !scope.installationOnly) {
    return null;
  }
  const unread = bell.data?.unread ?? 0;
  const attention = unreadAttentionCount(bell.data);
  const items = bell.data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-9"
          aria-label={
            unread === 0
              ? t("bell.label")
              : attention > 0
                ? t("bell.labelUnreadAttention", { count: unread, attention })
                : t("bell.labelUnread", { count: unread })
          }
        >
          <Bell aria-hidden="true" />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              data-tone={attention > 0 ? "attention" : "info"}
              className={cn(
                "absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] leading-4 font-medium",
                bellBadgeClass(attention),
              )}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <p className="text-sm font-medium">{t("bell.title")}</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={unread === 0 || markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            <CheckCheck aria-hidden="true" />
            {t("bell.markAll")}
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("bell.empty")}</p>
        ) : (
          <ul className="max-h-96 divide-y divide-border overflow-y-auto">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50",
                    item.read && "text-muted-foreground",
                  )}
                  onClick={() => {
                    if (!item.read) markRead.mutate({ ids: [item.id] });
                    if (isUpdateEvent(item.event)) {
                      setOpen(false);
                      void navigate({ to: installationSectionTo("updates") });
                    }
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={cn("mt-1.5 size-2 shrink-0 rounded-full", LEVEL_DOT[item.level])}
                  />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className={cn("block", !item.read && "font-medium")}>
                      {t(bellEventKey(item), {
                        defaultValue: item.message,
                        object:
                          typeof item.details?.objectName === "string"
                            ? item.details.objectName
                            : "",
                        rule:
                          typeof item.details?.ruleName === "string" ? item.details.ruleName : "",
                        version:
                          typeof item.details?.version === "string" ? item.details.version : "",
                      })}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      <RelativeTime value={item.createdAt} focusable={false} />
                      {item.read ? null : <span className="sr-only"> · {t("bell.unread")}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {scope.enabled && scope.canManage ? (
          <div className="border-t border-border px-4 py-2.5 text-right">
            <Link to={REPORTS_PATH as never} className="text-sm text-primary hover:underline">
              {t("bell.manage")}
            </Link>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
