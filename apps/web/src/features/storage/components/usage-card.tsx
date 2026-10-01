import { Database, Info } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";

import { ErrorState } from "@/components/error-state";
import { HORIZONTAL_GRID, IconButton, VALUE_AXIS_INTERVAL } from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dedupSavings, formatBytes, formatPercent } from "@/lib/format";
import type { StorageUsage, UsagePoint } from "../types";
import { USAGE_RANGES, type UsageRange, byteTicks, seriesForRange, usageDateLabel } from "../usage";
import { useStorageUsage } from "../use-storage";

/**
 * How much the tenant protects (logical) against what it takes in the chunk
 * store (physical), what deduplication saves, and how the store grew over
 * 30 or 90 days. One series, so no legend: the title names it.
 *
 * The chart's title is rendered once (the figure caption) and its note only
 * as the tooltip of an info button and as the chart's description for screen
 * readers, never as text under the chart.
 */
export function UsageCard() {
  const { t } = useTranslation("storage");
  const query = useStorageUsage();
  const [range, setRange] = React.useState<UsageRange>(30);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database aria-hidden="true" className="size-4 text-muted-foreground" />
            {t("usage.title")}
          </CardTitle>
          <CardDescription>{t("usage.description")}</CardDescription>
        </div>
        <Tabs
          value={String(range)}
          onValueChange={(value) => setRange(Number(value) as UsageRange)}
        >
          <TabsList aria-label={t("usage.range.label")}>
            {USAGE_RANGES.map((days) => (
              <TabsTrigger key={days} value={String(days)}>
                {t("usage.range.days", { count: days })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <UsageSkeleton />
        ) : query.isError ? (
          <ErrorState
            title={t("usage.error")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <UsageBody usage={query.data} range={range} />
        )}
      </CardContent>
    </Card>
  );
}

function UsageBody({ usage, range }: { usage: StorageUsage; range: UsageRange }) {
  const { t, i18n } = useTranslation("storage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const growth = range === 30 ? usage.growth.days30 : usage.growth.days90;
  const savings = dedupSavings(usage.retainedLogicalBytes, usage.physicalBytes);
  const empty = usage.physicalBytes === 0 && usage.logicalBytes === 0;

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label={t("usage.logical")}
          value={formatBytes(usage.logicalBytes, language)}
          hint={t("usage.logicalHint", { count: usage.protectedObjectCount })}
        />
        <Stat
          label={t("usage.physical")}
          value={formatBytes(usage.physicalBytes, language)}
          hint={t("usage.physicalHint", { count: usage.packCount })}
        />
        <Stat
          label={t("usage.savings")}
          value={formatPercent(savings, language)}
          hint={t("usage.savingsHint", {
            bytes: formatBytes(usage.retainedLogicalBytes, language),
            count: usage.snapshotCount,
          })}
        />
        <Stat
          label={t("usage.growth", { count: growth.days })}
          value={t("usage.growthValue", { bytes: formatBytes(growth.addedBytes, language) })}
          hint={
            growth.ratio === null
              ? t("usage.growthNoBaseline")
              : t("usage.growthRatio", { ratio: formatPercent(growth.ratio, language) })
          }
        />
      </dl>
      {empty ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {t("usage.empty")}
        </p>
      ) : (
        <UsageChart series={seriesForRange(usage.series, range)} />
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-xl font-semibold tabular-nums tracking-tight">{value}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}

function UsageChart({ series }: { series: UsagePoint[] }) {
  const { t, i18n } = useTranslation("storage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const baseId = `storage-usage-${React.useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const gradientId = `${baseId}-fill`;
  const titleId = `${baseId}-title`;
  const noteId = `${baseId}-note`;
  const first = series[0];
  const last = series.at(-1);
  const ticks = byteTicks(Math.max(0, ...series.map((point) => point.bytes)));

  return (
    <figure className="space-y-2" aria-labelledby={titleId} aria-describedby={noteId}>
      <figcaption className="flex items-center gap-1">
        <span id={titleId} className="text-sm font-medium">
          {t("usage.chartTitle")}
        </span>
        <IconButton
          icon={Info}
          label={t("usage.chartInfo")}
          tooltip={t("usage.growthNote")}
          size="icon-xs"
          aria-describedby={noteId}
          className="text-muted-foreground"
        />
      </figcaption>
      {/* The note for aria-describedby; shown to sighted users as the info button's tooltip. */}
      <p id={noteId} hidden>
        {t("usage.growthNote")}
      </p>
      <div
        className="h-56 w-full overflow-hidden"
        role="img"
        aria-label={
          first && last
            ? t("usage.chartLabel", {
                from: usageDateLabel(first.date, language, "long"),
                to: usageDateLabel(last.date, language, "long"),
                start: formatBytes(first.bytes, language),
                end: formatBytes(last.bytes, language),
              })
            : t("usage.chartTitle")
        }
        aria-describedby={noteId}
      >
        {/* recharts 3 renders once before it measures; a positive first size (h-56) avoids its -1 size warning. */}
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 320, height: 224 }}
        >
          <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.2} />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...HORIZONTAL_GRID} stroke="var(--border)" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              minTickGap={32}
              interval="preserveStartEnd"
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              tickFormatter={(date: string) => usageDateLabel(date, language, "short")}
            />
            <YAxis
              width={76}
              interval={VALUE_AXIS_INTERVAL}
              tickLine={false}
              axisLine={false}
              ticks={ticks}
              domain={[0, ticks.at(-1) ?? 0]}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              tickFormatter={(bytes: number) => (bytes === 0 ? "0" : formatBytes(bytes, language))}
            />
            <Tooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "3 3" }}
              content={<UsageTooltip language={language} />}
            />
            <Area
              type="monotone"
              dataKey="bytes"
              stroke="var(--primary)"
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <UsageTable series={series} labelledBy={titleId} />
    </figure>
  );
}

function UsageTooltip({
  active,
  payload,
  language,
}: Partial<TooltipContentProps<number, string>> & { language: string }) {
  const { t } = useTranslation("storage");
  const point = payload?.[0]?.payload as UsagePoint | undefined;
  if (!active || !point) {
    return null;
  }
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="font-medium">{usageDateLabel(point.date, language, "long")}</p>
      <p className="tabular-nums text-muted-foreground">
        {t("usage.tooltipStored", { bytes: formatBytes(point.bytes, language) })}
      </p>
    </div>
  );
}

/**
 * The same numbers as a table, for screen readers. The visually hidden box is
 * a wrapper, not the table: a table ignores the 1px size, and Firefox keeps a
 * table's caption outside the clipped table box, so `sr-only` on the table
 * itself showed its caption under the chart. The table is named by the figure
 * caption instead of a caption of its own.
 */
function UsageTable({ series, labelledBy }: { series: UsagePoint[]; labelledBy: string }) {
  const { t, i18n } = useTranslation("storage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div className="sr-only">
      <table aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col">{t("usage.tableDate")}</th>
            <th scope="col">{t("usage.tableBytes")}</th>
          </tr>
        </thead>
        <tbody>
          {series.map((point) => (
            <tr key={point.date}>
              <td>{usageDateLabel(point.date, language, "long")}</td>
              <td>{formatBytes(point.bytes, language)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
