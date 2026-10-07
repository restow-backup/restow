import { Bell, CheckCheck } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

import type { NotificationFilters } from "./api";
import { useMarkBellRead, useNotificationHistory, useReportsScope } from "./hooks";
import { NotificationRow, useOpenNotification } from "./notification-item";

const LEVELS = ["all", "attention", "error", "warning", "info"] as const;
type LevelFilter = (typeof LEVELS)[number];

/**
 * Notifications: everything the bell ever showed, not only its newest 30, a page at a time,
 * filtered by level and by unread. Events without a rule reach the bell only, so this is also
 * the one place they can be looked up later. Under "All tenants" every tenant's entries, each
 * with its tenant; opening one switches into it.
 */
export function NotificationsPage() {
  const { t } = useTranslation("reports");
  const scope = useReportsScope();
  const [level, setLevel] = React.useState<LevelFilter>("all");
  const [unread, setUnread] = React.useState(false);
  const filters: NotificationFilters = { level: level === "all" ? null : level, unread };
  const history = useNotificationHistory(filters);
  const markRead = useMarkBellRead();
  const open = useOpenNotification();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("history.title")}
        description={
          scope.allTenants
            ? t("history.descriptionAllTenants")
            : scope.tenantName
              ? t("history.description", { tenant: scope.tenantName })
              : t("history.descriptionInstallation")
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            <CheckCheck aria-hidden="true" />
            {t("bell.markAll")}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-4">
        <Select value={level} onValueChange={(value) => setLevel(value as LevelFilter)}>
          <SelectTrigger className="w-56" aria-label={t("history.level")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`history.levels.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 text-sm">
          <Switch id="notifications-unread" checked={unread} onCheckedChange={setUnread} />
          <label htmlFor="notifications-unread">{t("history.unreadOnly")}</label>
        </div>
      </div>
      {history.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : history.error ? (
        <ErrorState
          title={t("history.loadError")}
          error={history.error}
          onRetry={() => void history.refetch()}
          retrying={history.isFetching}
        />
      ) : history.items.length === 0 ? (
        <EmptyState icon={Bell} title={t("history.empty")} />
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <ul className="divide-y divide-border" data-slot="notification-history">
              {history.items.map((item) => (
                <li key={item.id}>
                  <NotificationRow item={item} onOpen={open} showTenant={scope.allTenants} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {history.hasNextPage ? (
        <Button
          variant="outline"
          loading={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {t("history.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}
