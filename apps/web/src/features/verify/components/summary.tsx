import { useTranslation } from "react-i18next";

import {
  EMPTY_ICON_CLASS,
  overallMeta,
  READINESS_CATEGORY_META,
  READINESS_TILE_ORDER,
  STATUS_TEXT,
  type StatusMeta,
  toneOf,
} from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import type { ReadinessSummary } from "@/features/verify/api";
import type { VerifyFormat } from "@/features/verify/use-verify";
import { cn } from "@/lib/utils";

/** The alert variant of each aggregate (an alert has no attention variant; the aggregate needs none). */
const BANNER_VARIANT = {
  green: "success",
  yellow: "warning",
  red: "destructive",
} as const;

/**
 * The tenant verdict in one sentence: what can be restored today. The aggregate is the worst
 * category that has objects (UI rework, decision 1): Not restorable counts the objects that
 * cannot be restored or have no backup yet, Not proven the ones that need attention or are
 * unverified. Objects to confirm are a sentence of their own, whatever the verdict.
 */
export function OverallBanner({ summary }: { summary: ReadinessSummary }) {
  const { t } = useTranslation("verify");
  const meta = overallMeta(summary.overall);
  const Icon = meta.icon;
  const toConfirm = summary.toConfirm ?? 0;
  const toConfirmSentence =
    toConfirm > 0 ? (
      <p data-flag="to-confirm">{t("summary.toConfirm", { count: toConfirm })}</p>
    ) : null;
  if (summary.overall === null) {
    // Nothing is rated, but objects may still wait for a confirmation (orphaned, never backed
    // up): they no longer decide the aggregate (decision 2) and must not vanish with it.
    return (
      <Alert variant="info" data-overall="none">
        <Icon />
        <AlertTitle>{t("overall.empty.title")}</AlertTitle>
        <AlertDescription>
          {t("overall.empty.description")}
          {toConfirmSentence}
        </AlertDescription>
      </Alert>
    );
  }
  const count =
    summary.overall === "red"
      ? summary.red + summary.noBackup
      : summary.overall === "yellow"
        ? summary.yellow + summary.unverified
        : 0;
  return (
    <Alert variant={BANNER_VARIANT[summary.overall]} data-overall={summary.overall}>
      <Icon />
      <AlertTitle>{t(`overall.${summary.overall}.title`)}</AlertTitle>
      <AlertDescription>
        {t(`overall.${summary.overall}.description`, { count, total: summary.total })}
        {toConfirmSentence}
      </AlertDescription>
    </Alert>
  );
}

function Tile({
  meta,
  label,
  hint,
  value,
  empty,
}: {
  meta: StatusMeta;
  label: string;
  hint: string;
  value: string;
  /** Nothing in this category: the tile is dimmed (UI rework, phase 1). */
  empty: boolean;
}) {
  const Icon = meta.icon;
  return (
    <Card
      className="py-0"
      data-category={meta.id}
      data-severity={meta.severity}
      data-empty={empty ? "true" : undefined}
    >
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className={cn("min-w-0 space-y-1", empty && "text-muted-foreground")}>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <Icon
          aria-hidden="true"
          data-category={meta.id}
          className={cn("size-5 shrink-0", empty ? EMPTY_ICON_CLASS : STATUS_TEXT[toneOf(meta)])}
        />
      </CardContent>
    </Card>
  );
}

/** The count of each tile's state in a summary. */
function countOf(summary: ReadinessSummary, state: (typeof READINESS_TILE_ORDER)[number]): number {
  return state === "no_backup" ? summary.noBackup : summary[state];
}

/**
 * Five counters, one per category, in the overview's order: Ready, Needs attention,
 * Unverified, Not restorable, No backup yet. A category with nothing in it is dimmed.
 */
export function SummaryTiles({
  summary,
  format,
}: {
  summary: ReadinessSummary;
  format: VerifyFormat;
}) {
  const { t } = format;
  return (
    <div className="grid grid-cols-1 gap-4 *:min-w-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {READINESS_TILE_ORDER.map((state) => {
        const meta = READINESS_CATEGORY_META[state];
        const count = countOf(summary, state);
        return (
          <Tile
            key={state}
            meta={meta}
            label={t(meta.labelKey)}
            hint={t(`summary.hint.${state}`, { overdue: summary.overdue })}
            value={format.integer(count)}
            empty={count === 0}
          />
        );
      })}
    </div>
  );
}
