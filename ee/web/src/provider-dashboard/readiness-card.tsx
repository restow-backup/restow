import { BadgeCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ReadinessBar,
  type ReadinessCounts,
  ReadinessLegend,
} from "@/features/dashboard/components/readiness-legend";
import { formatInteger, formatPercent } from "@/lib/format";

import "@/features/dashboard/i18n";

/**
 * The recovery readiness of every tenant at once: the share of the protected
 * objects that a restore check proved, the objects by state as one bar, and the
 * legend whose rows open Recovery readiness by tenant (`/verify?state=...&scope=all`).
 * Green is what a restore check passed; nothing else counts as ready.
 */
export function ProviderReadinessCard({
  readiness,
  loading,
}: {
  readiness: ReadinessCounts | null;
  loading: boolean;
}) {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <Card data-widget="provider-readiness" className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BadgeCheck className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("provider.readiness.title")}
        </CardTitle>
        <CardDescription>{t("provider.readiness.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading || !readiness ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tabular-nums">
                {readiness.total === 0
                  ? "–"
                  : formatPercent(readiness.green / readiness.total, language)}
              </span>
              <span className="text-sm text-muted-foreground">
                {t("provider.readiness.share", {
                  total: readiness.total,
                  formatted: formatInteger(readiness.total, language),
                })}
              </span>
            </p>
            <ReadinessBar counts={readiness} />
            <ReadinessLegend counts={readiness} scope="all" linkable />
            <p className="text-xs text-muted-foreground">{t("provider.readiness.hint")}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
