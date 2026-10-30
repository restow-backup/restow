import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  Activity,
  AtSign,
  Building2,
  Cloud,
  Container,
  FolderOpen,
  Globe,
  Laptop,
  type LucideIcon,
  Mail,
  Monitor,
  Server,
  Users,
  WifiOff,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  RelativeTime,
  STATUS_CHART_COLOR,
  StatusBadge,
  VALUE_AXIS_INTERVAL,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import { useSecondClock } from "@/features/history/live/clock";
import { formatClock } from "@/features/history/samples";
import { guestTo } from "@/features/pve/paths";
import { formatBytes, formatInteger, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { RunningWidget as RunningData } from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";
import { jobTo, PATHS, to } from "../paths.js";
import type { WidgetView } from "../presenters.js";
import {
  currentBps,
  currentTotal,
  elapsedMs,
  type RatePoint,
  RUNNING_WINDOW_MS,
  type RunningItem,
  type RunningObject,
  sparkPath,
  summarizeTotal,
} from "../running-model.js";
import {
  type AllTenantsFeed,
  type RunningFreshness,
  type RunningSeries,
  useAllTenantsRunning,
  useRunningSeries,
  useTenantRunning,
} from "../use-running.js";

/**
 * "Running now": what is being copied or backed up this moment. The tenant's page keeps it
 * current from the live channel; "All tenants" asks for every tenant's runs at a steady pace.
 * Each run shows its object, kind, elapsed time, what it has done so far, its speed and a small
 * line of that speed over the last minutes; above them one graph adds the speeds up. The graphs
 * are for the eye: every figure they show is also written out in the rows and in the text under
 * the total graph, so nothing depends on seeing them.
 */

/** Runs shown before "Show all". */
export const RUNNING_ROWS_SHOWN = 8;

const OBJECT_ICON: Readonly<Record<RunningObject | "tenant", LucideIcon>> = {
  mailbox: Mail,
  onedrive: Cloud,
  site: Globe,
  group: Users,
  imap: AtSign,
  server: Server,
  client: Laptop,
  file_share: FolderOpen,
  vm: Monitor,
  ct: Container,
  tenant: Building2,
};

const minutes = RUNNING_WINDOW_MS / 60_000;

function useLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "34 % · 3.2 GB of 9.4 GB · 120 of 400 items": what a run has done, as far as it knows. */
export function progressParts(t: TFunction, language: string, item: RunningItem): string[] {
  const parts: string[] = [];
  if (item.percent !== null) {
    parts.push(t("running.row.percent", { percent: item.percent }));
  }
  if (item.bytesDone !== null && item.bytesDone > 0) {
    parts.push(
      item.bytesTotal !== null && item.bytesTotal > 0
        ? t("running.row.bytes", {
            done: formatBytes(item.bytesDone, language),
            total: formatBytes(item.bytesTotal, language),
          })
        : t("running.row.bytesDone", { done: formatBytes(item.bytesDone, language) }),
    );
  }
  if (item.itemsDone !== null && (item.itemsDone > 0 || item.itemsTotal !== null)) {
    parts.push(
      item.itemsTotal !== null
        ? t("running.row.items", {
            done: formatInteger(item.itemsDone, language),
            total: formatInteger(item.itemsTotal, language),
          })
        : t("running.row.itemsDone", { done: formatInteger(item.itemsDone, language) }),
    );
  }
  return parts;
}

function rateText(t: TFunction, language: string, bps: number | null): string | null {
  return bps === null ? null : t("running.row.rate", { rate: formatBytes(bps, language) });
}

// ---------------------------------------------------------------------------
// The small line of one run
// ---------------------------------------------------------------------------

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 24;

/** A run's speed over the last minutes, in Lapis like every running operation; decoration only. */
export function RateSparkline({ points, now }: { points: readonly RatePoint[]; now: number }) {
  const path = sparkPath(points, SPARK_WIDTH, SPARK_HEIGHT, now - RUNNING_WINDOW_MS, now);
  if (!path.last) {
    // The same width, so a row does not jump when the first figures arrive.
    return (
      <span
        aria-hidden="true"
        className="inline-block shrink-0"
        style={{ width: SPARK_WIDTH, height: SPARK_HEIGHT }}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      data-slot="sparkline"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      className="shrink-0 overflow-visible"
    >
      <polygon points={path.area} fill="var(--chart-info)" fillOpacity={0.1} />
      <polyline
        points={path.line}
        fill="none"
        stroke="var(--chart-info)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={path.last.x} cy={path.last.y} r={2.5} fill="var(--chart-info)" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function RunName({ item, label }: { item: RunningItem; label: string }) {
  const className =
    "block min-w-0 truncate font-medium underline-offset-4 hover:underline focus-visible:underline";
  if (item.tenant) {
    // Another tenant's run opens in that tenant, which the viewer switches into first.
    return (
      <span className={cn(className, "no-underline")} title={label}>
        {label}
      </span>
    );
  }
  const target = item.link.kind === "guest" ? guestTo(item.link.id).to : jobTo(item.id);
  return (
    <Link to={target} className={className} title={label}>
      {label}
    </Link>
  );
}

function RunRow({
  item,
  points,
  now,
  clock,
  onOpenTenant,
}: {
  item: RunningItem;
  points: readonly RatePoint[];
  now: number;
  clock: number;
  onOpenTenant?: (tenantId: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  const Icon = OBJECT_ICON[item.object ?? "tenant"];
  const label = item.name ?? t("running.object.tenant");
  const elapsed = elapsedMs(item, clock);
  const parts = progressParts(t, language, item);
  const rate = rateText(t, language, currentBps(item, now));
  const objectLabel = t(`running.object.${item.object ?? "tenant"}`);
  const meta = [
    objectLabel,
    item.category === "backup" ? null : t(`running.category.${item.category}`),
    item.jobName,
  ].filter((part): part is string => part !== null && part !== "");

  return (
    <li
      data-slot="running-row"
      data-source={item.source}
      data-category={item.category}
      className="grid gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_auto] sm:items-center"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <RunName item={item} label={label} />
          <p className="truncate text-xs text-muted-foreground">
            {item.tenant ? (
              <>
                {onOpenTenant ? (
                  <button
                    type="button"
                    onClick={() => onOpenTenant((item.tenant as { id: string }).id)}
                    aria-label={t("running.row.openTenant", { tenant: item.tenant.name })}
                    className="rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {item.tenant.name}
                  </button>
                ) : (
                  <span className="font-medium text-foreground">{item.tenant.name}</span>
                )}
                {" · "}
              </>
            ) : null}
            {meta.join(" · ")}
          </p>
        </div>
      </div>

      <div className="min-w-0 space-y-1">
        {item.percent !== null ? (
          <Progress
            value={item.percent}
            aria-label={t("running.row.progress", { name: label })}
            className="h-1.5"
          />
        ) : null}
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
          {parts.length > 0 ? <span>{parts.join(" · ")}</span> : null}
          {item.cancelling ? (
            <StatusBadge tone="warning">{t("running.row.cancelling")}</StatusBadge>
          ) : null}
          {item.throttled ? (
            <StatusBadge tone="muted">{t("running.row.throttled")}</StatusBadge>
          ) : null}
        </p>
      </div>

      <div className="flex items-center gap-3 sm:justify-end">
        {/* Decoration: the speed beside it says the same in words. */}
        <RateSparkline points={points} now={now} />
        <div className="min-w-20 text-right text-xs tabular-nums sm:min-w-24">
          <p className="text-sm font-medium text-foreground">
            {rate ?? (
              <>
                <span aria-hidden="true">–</span>
                <span className="sr-only">{t("running.row.noRate")}</span>
              </>
            )}
          </p>
          {elapsed !== null ? (
            <p className="text-muted-foreground">
              {t("running.row.elapsed", { time: formatClock(elapsed / 1000) })}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The total
// ---------------------------------------------------------------------------

/** One tick per full minute of the window: the labels say minutes, so no two can read alike. */
function minuteTicks(from: number, to: number): number[] {
  const ticks: number[] = [];
  for (let at = Math.ceil(from / 60_000) * 60_000; at <= to; at += 60_000) {
    ticks.push(at);
  }
  return ticks;
}

function clockLabel(at: number, language: string): string {
  return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(at);
}

/** The speeds of all runs added up over the last minutes, with the same figures written out. */
export function TotalGraph({
  total,
  now,
  count,
  hasData,
}: {
  total: readonly RatePoint[];
  now: number;
  count: number;
  /** Some run has said a speed lately; without, a flat line at 0 would claim a speed of 0. */
  hasData: boolean;
}) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  const summary = summarizeTotal(total);
  const rate = (value: number) => t("running.row.rate", { rate: formatBytes(value, language) });
  // A running operation is Lapis, like the small lines of the rows.
  const config = {
    bps: { label: t("running.total.series"), color: STATUS_CHART_COLOR.info },
  } satisfies ChartConfig;
  const text = t("running.total.summary", {
    count,
    minutes,
    current: rate(summary.current),
    average: rate(summary.average),
    peak: rate(summary.peak),
  });

  if (!hasData) {
    return (
      <figure data-slot="running-total" data-state="none" className="space-y-1">
        <figcaption className="text-sm font-medium">{t("running.total.title")}</figcaption>
        <p className="text-sm text-muted-foreground">{t("running.total.none")}</p>
      </figure>
    );
  }

  return (
    <figure data-slot="running-total" className="space-y-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium">{t("running.total.title")}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {t("running.total.now", { rate: rate(summary.current) })}
        </span>
      </figcaption>
      <div role="img" aria-label={t("running.total.label", { minutes })}>
        <ChartContainer config={config} className="aspect-auto h-36 w-full">
          <AreaChart data={[...total]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="at"
              type="number"
              scale="time"
              domain={[now - RUNNING_WINDOW_MS, now]}
              tickLine={false}
              axisLine={false}
              ticks={minuteTicks(now - RUNNING_WINDOW_MS, now)}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              tickFormatter={(at: number) => clockLabel(at, language)}
            />
            <YAxis
              interval={VALUE_AXIS_INTERVAL}
              width={88}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              // A no-break space keeps "85,8 MB/s" on one line.
              tickFormatter={(value: number) => rate(value).replace(/ /g, "\u00a0")}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)" }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    clockLabel(Number(payload[0]?.payload?.at ?? now), language)
                  }
                  formatter={(value) => rate(Number(value))}
                  hideIndicator
                />
              }
            />
            <Area
              dataKey="bps"
              type="monotone"
              stroke="var(--color-bps)"
              strokeWidth={2}
              fill="var(--color-bps)"
              fillOpacity={0.12}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      </div>
      <p className="sr-only">{text}</p>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// How current it is
// ---------------------------------------------------------------------------

function ago(asOf: number | null, language: string): string {
  return (asOf === null ? null : formatRelative(new Date(asOf).toISOString(), language)) ?? "–";
}

/** Whether the figures move on their own, or why they do not (the last known state stays). */
export function FreshnessNote({ freshness }: { freshness: RunningFreshness }) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  switch (freshness.kind) {
    case "live":
      return (
        <StatusBadge tone="info" live data-slot="running-freshness" data-freshness="live">
          {t("running.status.live")}
        </StatusBadge>
      );
    case "polling":
      return (
        <p
          data-slot="running-freshness"
          data-freshness="polling"
          className="text-xs text-muted-foreground"
        >
          {t("running.status.polling", { seconds: freshness.seconds })}
        </p>
      );
    case "connecting":
      return (
        <p
          data-slot="running-freshness"
          data-freshness="connecting"
          className="text-xs text-muted-foreground"
        >
          {t("running.status.connecting")}
        </p>
      );
    default:
      return (
        <p
          role="status"
          data-slot="running-freshness"
          data-freshness={freshness.kind}
          className="flex items-center gap-1.5 text-xs text-warning-foreground dark:text-warning"
        >
          <WifiOff className="size-3.5 shrink-0" aria-hidden="true" />
          {t(`running.status.${freshness.kind}`, { time: ago(freshness.asOf, language) })}
        </p>
      );
  }
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

export interface RunningNowViewProps {
  items: readonly RunningItem[];
  freshness: RunningFreshness;
  series: RunningSeries;
  /** The earliest planned start, for the empty state. */
  nextRunAt: string | null;
  /** The tenant that start belongs to, on "All tenants". */
  nextTenant?: string | null;
  /** More runs were going on than listed. */
  truncated?: boolean;
  /** Tenants that could not be read ("All tenants"). */
  unavailable?: number;
  onOpenTenant?: (tenantId: string) => void;
}

function NextStart({ nextRunAt, tenant }: { nextRunAt: string | null; tenant?: string | null }) {
  const { t } = useTranslation("dashboard");
  if (!nextRunAt) {
    return <>{t("running.empty.nextNone")}</>;
  }
  if (Date.parse(nextRunAt) <= Date.now()) {
    return <>{t("running.empty.nextDue")}</>;
  }
  return (
    <>
      {t("running.empty.next")} <RelativeTime value={nextRunAt} />
      {tenant ? <> · {tenant}</> : null}
    </>
  );
}

/** What runs, with the total graph and a row per run; or the calm "nothing is running". */
export function RunningNowView({
  items,
  freshness,
  series,
  nextRunAt,
  nextTenant,
  truncated,
  unavailable = 0,
  onOpenTenant,
}: RunningNowViewProps) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  const [expanded, setExpanded] = React.useState(false);
  const clock = useSecondClock(items.length > 0);
  const tenants = new Set(items.flatMap((item) => (item.tenant ? [item.tenant.id] : []))).size;
  const rate = currentTotal(items, series.now);
  const shown = expanded ? items : items.slice(0, RUNNING_ROWS_SHOWN);
  const hidden = items.length - shown.length;

  const note = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <FreshnessNote freshness={freshness} />
      {unavailable > 0 ? (
        <p className="text-xs text-warning-foreground dark:text-warning">
          {t("running.unavailable", { count: unavailable })}
        </p>
      ) : null}
    </div>
  );

  if (items.length === 0) {
    return (
      <div data-slot="running-body" data-state="empty" className="space-y-3">
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Activity className="size-5" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium">{t("running.empty.title")}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            <NextStart nextRunAt={nextRunAt} tenant={nextTenant} />
          </p>
        </div>
        <div className="flex justify-center">{note}</div>
      </div>
    );
  }

  return (
    <div data-slot="running-body" data-state="running" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-muted-foreground">
          {/* Only the count is announced: the speed beside it changes every few seconds. */}
          <span className="font-medium text-foreground" aria-live="polite">
            {t("running.count", { count: items.length })}
          </span>
          {tenants > 0 ? <> · {t("running.tenantsBusy", { count: tenants })}</> : null}
          {rate !== null ? <> · {rateText(t, language, rate)}</> : null}
        </p>
        {note}
      </div>

      <TotalGraph
        total={series.total}
        now={series.now}
        count={items.length}
        hasData={series.hasData}
      />

      <ul className="divide-y" aria-label={t("running.title")}>
        {shown.map((item) => (
          <RunRow
            key={item.key}
            item={item}
            points={series.points(item.key)}
            now={series.now}
            clock={clock}
            onOpenTenant={onOpenTenant}
          />
        ))}
      </ul>

      {hidden > 0 || expanded ? (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((open) => !open)}>
          {expanded ? t("running.fewer") : t("running.more", { count: items.length })}
        </Button>
      ) : null}
      {truncated ? <p className="text-xs text-muted-foreground">{t("running.truncated")}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tenant's widget
// ---------------------------------------------------------------------------

function TenantRunningBody({ snapshot }: { snapshot: RunningData }) {
  const feed = useTenantRunning(snapshot);
  // The history is the tenant's: another tenant starts a new one.
  const tenantId = useSession().activeTenant?.id ?? "";
  const series = useRunningSeries(feed.items, `tenant:${tenantId}`, feed.fresh);
  return (
    <RunningNowView
      items={feed.items}
      freshness={feed.freshness}
      series={series}
      nextRunAt={snapshot.nextRunAt}
      truncated={feed.truncated}
    />
  );
}

/** What runs in the tenant right now (administrators); live while the channel is connected. */
export function RunningNowWidget(props: WidgetStateProps<RunningData>) {
  const { t } = useTranslation("dashboard");
  return (
    <WidgetCard
      id="running"
      {...props}
      title={t("running.title")}
      description={t("running.description")}
      icon={Activity}
      action={
        <LinkButton to={to(PATHS.jobs)} variant="ghost">
          {t("running.all")}
        </LinkButton>
      }
      skeleton={<div className="h-40 animate-pulse rounded-md bg-muted" />}
    >
      {(data) => <TenantRunningBody snapshot={data} />}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// All tenants
// ---------------------------------------------------------------------------

function AllTenantsBody({
  feed,
  onOpenTenant,
}: {
  feed: AllTenantsFeed;
  onOpenTenant?: (tenantId: string) => void;
}) {
  const series = useRunningSeries(feed.items, "all", feed.fresh);
  return (
    <RunningNowView
      items={feed.items}
      freshness={feed.freshness}
      series={series}
      nextRunAt={feed.next?.at ?? null}
      nextTenant={feed.next?.name ?? null}
      truncated={feed.truncated}
      unavailable={feed.unavailable}
      onOpenTenant={onOpenTenant}
    />
  );
}

/** What runs in every tenant right now, on the "All tenants" start page (provider admins). */
export function AllTenantsRunningWidget({
  onOpenTenant,
}: {
  onOpenTenant?: (tenantId: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  const feed = useAllTenantsRunning();
  const view: WidgetView<AllTenantsFeed> = feed.isPending
    ? { kind: "loading" }
    : feed.isError && !feed.hasData
      ? { kind: "error", error: feed.error }
      : { kind: "ready", data: feed };
  return (
    <WidgetCard
      id="running"
      view={view}
      onRetry={feed.refetch}
      retrying={feed.isFetching}
      title={t("running.title")}
      description={t("running.descriptionAll")}
      icon={Activity}
      skeleton={<div className="h-40 animate-pulse rounded-md bg-muted" />}
    >
      {(data) => <AllTenantsBody feed={data} onOpenTenant={onOpenTenant} />}
    </WidgetCard>
  );
}
