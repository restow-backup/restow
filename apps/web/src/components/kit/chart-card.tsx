import { ChartNoAxesColumn, Info } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { EmptyState } from "./empty-state.js";
import { UI_NAMESPACE } from "./i18n.js";

export interface ChartCardProps {
  title: string;
  description?: string;
  /** Right-aligned menu in the header, for example a DropdownMenu with a CSV export. */
  menu?: React.ReactNode;
  /**
   * Series labels and colours: `STATUS_CHART_COLOR` for status-coded series
   * (outcomes, readiness), the theme tokens `var(--chart-1)` .. `var(--chart-5)`
   * for categorical ones. Never the UI tones (`var(--warning)`, ...).
   */
  config: ChartConfig;
  /** One recharts chart (BarChart, AreaChart, ...). */
  children: React.ComponentProps<typeof ChartContainer>["children"];
  loading?: boolean;
  /** Why the data could not be loaded; shown with a retry when `onRetry` is set. */
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /** There is nothing to plot yet. */
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  /** A way out of the empty state, e.g. "Start a backup". */
  emptyAction?: React.ReactNode;
  /** The chart cannot exist here, and why (not offered here, missing permission, ...). */
  unavailable?: string | null;
  /** One sentence for screen readers on what the chart shows. */
  summary?: string;
  footer?: React.ReactNode;
  /** Height of the plot area and of every state, so nothing shifts (default `h-64`). */
  chartClassName?: string;
  className?: string;
}

/**
 * A chart in a card with its title, description and menu, and every state
 * around it: unavailable (with the reason), loading skeleton, error with
 * retry, empty, and finally the shadcn ChartContainer with the chart. All
 * states share the plot height, so the page does not jump when data arrives.
 */
export function ChartCard({
  title,
  description,
  menu,
  config,
  children,
  loading = false,
  error,
  onRetry,
  retrying = false,
  empty = false,
  emptyTitle,
  emptyDescription,
  emptyAction,
  unavailable,
  summary,
  footer,
  chartClassName = "h-64",
  className,
}: ChartCardProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  const frame = cn("w-full", chartClassName);

  let body: React.ReactNode;
  if (unavailable) {
    body = (
      <div
        data-state="unavailable"
        className={cn(
          frame,
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 text-center",
        )}
      >
        <Info className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">{t("chart.unavailable")}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{unavailable}</p>
      </div>
    );
  } else if (loading) {
    body = (
      <div data-state="loading" aria-busy="true" className={frame}>
        <Skeleton className="size-full" />
        <span className="sr-only">{t("chart.loading")}</span>
      </div>
    );
  } else if (error !== undefined && error !== null) {
    body = (
      <div data-state="error" className={cn(frame, "flex items-center justify-center")}>
        <ErrorState
          title={t("chart.error")}
          error={error}
          onRetry={onRetry}
          retrying={retrying}
          className="max-w-lg"
        />
      </div>
    );
  } else if (empty) {
    body = (
      <EmptyState
        icon={ChartNoAxesColumn}
        title={emptyTitle ?? t("chart.empty.title")}
        description={emptyDescription ?? t("chart.empty.description")}
        actions={emptyAction}
        className={cn(frame, "py-0")}
      />
    );
  } else {
    body = (
      <>
        <ChartContainer config={config} className={cn("aspect-auto", frame)}>
          {children}
        </ChartContainer>
        {summary ? <p className="sr-only">{summary}</p> : null}
      </>
    );
  }

  return (
    <Card data-slot="chart-card" className={cn("gap-4", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {menu ? <CardAction>{menu}</CardAction> : null}
      </CardHeader>
      <CardContent>{body}</CardContent>
      {footer ? <CardFooter className="text-sm text-muted-foreground">{footer}</CardFooter> : null}
    </Card>
  );
}
