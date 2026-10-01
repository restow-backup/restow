import { BadgeCheck, CircleAlert, ShieldQuestion, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { ReadinessWidget as ReadinessData } from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";
import { PATHS, to } from "../paths.js";
import { readinessSegments, readinessTone } from "../presenters.js";

/** The fill of each tone in the breakdown bar and its legend (shared with the endpoints card). */
export const SEGMENT_FILL = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
  info: "bg-info",
  neutral: "bg-foreground",
} as const;

function ReadinessSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-28 rounded-full" />
      <Skeleton className="h-2 w-full rounded-full" />
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-20" />
      </div>
    </div>
  );
}

function ReadinessBody({ data, canAdminister }: { data: ReadinessData; canAdminister: boolean }) {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const segments = readinessSegments(data);
  const count = (value: number) => formatInteger(value, language);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge tone={readinessTone(data.overall)} icon className="text-sm">
          {t(`readiness.overall.${data.overall ?? "none"}`)}
        </StatusBadge>
        <span className="text-xs text-muted-foreground">
          {data.lastCheckedAt ? (
            <>
              {t("readiness.lastCheck")} <RelativeTime value={data.lastCheckedAt} />
            </>
          ) : (
            t("readiness.neverChecked")
          )}
        </span>
      </div>

      <div
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={cn("h-full", SEGMENT_FILL[segment.tone])}
            style={{ width: `${(segment.count / Math.max(1, data.total)) * 100}%` }}
          />
        ))}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {segments.map((segment) => (
          <div
            key={segment.key}
            data-segment={segment.key}
            className="flex items-center justify-between gap-2"
          >
            <dt className="flex items-center gap-2 text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-2 rounded-full", SEGMENT_FILL[segment.tone])}
              />
              {t(`readiness.segments.${segment.key}`)}
            </dt>
            <dd className="font-medium tabular-nums">{count(segment.count)}</dd>
          </div>
        ))}
      </dl>

      {data.unverified > 0 ? (
        <Alert variant="warning" data-flag="unverified">
          <TriangleAlert />
          <AlertTitle>{t("readiness.unverified.title", { count: data.unverified })}</AlertTitle>
          <AlertDescription className="gap-2">
            <p>{t("readiness.unverified.description")}</p>
            {canAdminister ? (
              <LinkButton to={to(PATHS.verify)} size="xs" className="mt-1">
                {t("readiness.unverified.action")}
              </LinkButton>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {data.noBackup > 0 ? (
        <Alert variant="destructive" data-flag="no-backup">
          <CircleAlert />
          <AlertTitle>{t("readiness.noBackup.title", { count: data.noBackup })}</AlertTitle>
          <AlertDescription>{t("readiness.noBackup.description")}</AlertDescription>
        </Alert>
      ) : null}

      {data.overdue > 0 || data.running > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {data.overdue > 0 ? (
            <StatusBadge tone="warning">
              {t("readiness.overdue", { count: data.overdue })}
            </StatusBadge>
          ) : null}
          {data.running > 0 ? (
            <StatusBadge tone="info" live>
              {t("readiness.running", { count: data.running })}
            </StatusBadge>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Recovery readiness: the tenant's worst rating, the objects by state and,
 * flagged on their own, backups whose newest snapshot was never read back.
 * A backup without a verified restore never counts as fine.
 */
export function ReadinessWidget({
  canAdminister,
  ...props
}: WidgetStateProps<ReadinessData> & { canAdminister: boolean }) {
  const { t } = useTranslation("dashboard");
  return (
    <WidgetCard
      id="readiness"
      {...props}
      title={t("readiness.title")}
      description={t("readiness.description")}
      icon={BadgeCheck}
      skeleton={<ReadinessSkeleton />}
      action={
        canAdminister ? (
          <LinkButton to={to(PATHS.verify)} variant="ghost">
            {t("actions.details")}
          </LinkButton>
        ) : null
      }
      empty={(data) =>
        data.total === 0
          ? {
              icon: ShieldQuestion,
              title: t("readiness.empty.title"),
              description: t("readiness.empty.description"),
              action: canAdminister ? (
                <LinkButton to={to(PATHS.protectedObjects)}>
                  {t("readiness.empty.action")}
                </LinkButton>
              ) : undefined,
            }
          : null
      }
    >
      {(data) => <ReadinessBody data={data} canAdminister={canAdminister} />}
    </WidgetCard>
  );
}
