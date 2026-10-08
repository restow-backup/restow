import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import type { BellNotification } from "./api";
import { useMarkBellRead, useReportsScope } from "./hooks";
import { notificationTarget } from "./notification-target";

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

const LEVEL_DOT: Record<BellNotification["level"], string> = {
  info: "bg-muted-foreground/60",
  warning: "bg-warning",
  error: "bg-destructive",
};

/** The line of a notification in the reader's language. */
export function useNotificationText() {
  const { t } = useTranslation("reports");
  return (item: BellNotification) =>
    t(bellEventKey(item), {
      defaultValue: item.message,
      object: typeof item.details?.objectName === "string" ? item.details.objectName : "",
      rule: typeof item.details?.ruleName === "string" ? item.details.ruleName : "",
      version: typeof item.details?.version === "string" ? item.details.version : "",
      days: typeof item.details?.days === "number" ? item.details.days : "",
    });
}

/**
 * Opening a notification: it is marked read and, where it has one, its cause opens (the run,
 * the machine, the restore check ...). Under "All tenants" the entry's tenant becomes the
 * active one first, so the page shows that tenant and not the one chosen before.
 */
export function useOpenNotification(onOpened?: () => void) {
  const scope = useReportsScope();
  const session = useSession();
  const markRead = useMarkBellRead();
  const navigate = useNavigate();
  return React.useCallback(
    (item: BellNotification) => {
      if (!item.read) markRead.mutate({ ids: [item.id] });
      const target = notificationTarget(item, {
        canManage: scope.canManage || scope.allTenants,
        isProviderAdmin: scope.isProviderAdmin,
      });
      if (!target) return;
      if (target.tenantId && (scope.allTenants || target.tenantId !== session.activeTenant?.id)) {
        session.setActiveTenant(target.tenantId);
      }
      onOpened?.();
      void navigate({ to: target.to as never });
    },
    [markRead, navigate, onOpened, scope, session],
  );
}

/** One notification as a button: level, line, tenant (across tenants) and time. */
export function NotificationRow({
  item,
  onOpen,
  showTenant,
}: {
  item: BellNotification;
  onOpen: (item: BellNotification) => void;
  showTenant: boolean;
}) {
  const { t } = useTranslation("reports");
  const text = useNotificationText();
  return (
    <button
      type="button"
      data-event={item.event}
      className={cn(
        "flex w-full items-start gap-3 px-4 py-3 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50",
        item.read && "text-muted-foreground",
      )}
      onClick={() => onOpen(item)}
    >
      <span
        aria-hidden="true"
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", LEVEL_DOT[item.level])}
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className={cn("block", !item.read && "font-medium")}>{text(item)}</span>
        <span className="block text-xs text-muted-foreground">
          {showTenant && item.tenant ? (
            <span data-slot="tenant">{item.tenant.name} · </span>
          ) : showTenant && item.tenantId === null ? (
            <span data-slot="tenant">{t("bell.installation")} · </span>
          ) : null}
          <RelativeTime value={item.createdAt} focusable={false} />
          {item.read ? null : <span className="sr-only"> · {t("bell.unread")}</span>}
        </span>
      </span>
    </button>
  );
}
