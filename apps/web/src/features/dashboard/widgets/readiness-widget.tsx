import { BadgeCheck, CircleAlert, ShieldQuestion, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

import { inventoryTo } from "@/features/endpoints/paths";
import { verifyLink } from "@/features/verify/search";
import type { ReadinessWidget as ReadinessData } from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { ReadinessBar, ReadinessLegend } from "../components/readiness-legend.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";
import { PATHS, to } from "../paths.js";
import { readinessTone } from "../presenters.js";

// The endpoints card builds its bar and legend from the same fills.
export { SEGMENT_FILL } from "../components/readiness-legend.js";

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
  const { t } = useTranslation("dashboard");

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

      <ReadinessBar counts={data} />
      {/* Every row opens the table of exactly those objects; only administrators have that page. */}
      <ReadinessLegend counts={data} scope="tenant" linkable={canAdminister} />
      {canAdminister ? (
        <p className="text-xs text-muted-foreground">{t("readiness.legendHint")}</p>
      ) : null}

      {data.unverified > 0 ? (
        <Alert variant="warning" data-flag="unverified">
          <TriangleAlert />
          <AlertTitle>{t("readiness.unverified.title", { count: data.unverified })}</AlertTitle>
          <AlertDescription className="gap-2">
            <p>{t("readiness.unverified.description")}</p>
            {canAdminister ? (
              <LinkButton {...verifyLink("unverified")} size="xs" className="mt-1">
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
          <AlertDescription className="gap-2">
            <p>{t("readiness.noBackup.description")}</p>
            {canAdminister ? (
              <LinkButton {...verifyLink("no_backup")} size="xs" className="mt-1">
                {t("readiness.noBackup.action")}
              </LinkButton>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {data.withoutJob > 0 ? (
        <Alert variant="warning" data-flag="without-job">
          <TriangleAlert />
          <AlertTitle>{t("readiness.withoutJob.title", { count: data.withoutJob })}</AlertTitle>
          <AlertDescription className="gap-2">
            <p>{t("readiness.withoutJob.description")}</p>
            {canAdminister ? (
              <LinkButton to={inventoryTo()} size="xs" className="mt-1">
                {t("readiness.withoutJob.action")}
              </LinkButton>
            ) : null}
          </AlertDescription>
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
