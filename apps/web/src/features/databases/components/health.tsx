import { Activity, AlertTriangle, HardDrive } from "lucide-react";
import * as React from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  byteAxisTicks,
  ChartCard,
  ErrorState,
  HORIZONTAL_GRID,
  RelativeTime,
  StatusBadge,
  VALUE_AXIS_INTERVAL,
} from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatPercent } from "@/lib/format";

import type { DbBandHour, DbConnection, DbHealthEvent } from "../api.js";
import { type DbFormat, useConnectionHealth, useDatabaseSizes } from "../hooks.js";
import {
  BAND_COLOR,
  bandCounts,
  codeKey,
  countTicks,
  formatLatency,
  HEALTH_RANGES,
  type HealthRange,
  reachabilityView,
} from "../presenters.js";

/**
 * The health checks of a connection (docs/DATABASES.md 8, stage D2): the band of the last 24
 * hours in the list, and on the connection page availability over 24 hours, 7 and 30 days, the
 * response time and the connections in use, and the events. A connection that answers is no proof
 * of anything (green is a passed restore check): good hours are Lapis, problems warning or red,
 * hours without a check grey. Every chart says in one sentence what it shows, and the band names
 * each hour.
 */

const AXIS = { tickLine: false, axisLine: false, tickMargin: 8 } as const;

/** 24 cells, one per hour, oldest left; each named, with one sentence for the whole band. */
export function HealthBand({
  band,
  format,
  className,
}: {
  band: readonly DbBandHour[];
  format: DbFormat;
  className?: string;
}) {
  const { t } = format;
  if (band.length === 0) {
    return null;
  }
  const counts = bandCounts(band);
  const summary = t("health.band.summary", counts);
  const width = 4;
  const gap = 1;
  return (
    <svg
      role="img"
      aria-label={summary}
      data-slot="health-band"
      viewBox={`0 0 ${band.length * (width + gap) - gap} 14`}
      width={band.length * (width + gap) - gap}
      height={14}
      className={className}
    >
      <title>{summary}</title>
      {band.map((hour, index) => (
        <rect
          key={hour.at}
          x={index * (width + gap)}
          y={0}
          width={width}
          height={14}
          rx={1}
          fill={BAND_COLOR[hour.state]}
          data-state={hour.state}
        >
          <title>
            {t("health.band.hour", {
              time: format.dateTime(hour.at) ?? hour.at,
              state: t(`health.band.state.${hour.state}`),
            })}
          </title>
        </rect>
      ))}
    </svg>
  );
}

function eventText(event: DbHealthEvent, format: DbFormat): string {
  const { t } = format;
  const at = (value: string) => format.dateTime(value) ?? value;
  switch (event.kind) {
    case "unreachable":
      return event.to
        ? t("health.events.unreachable", { from: at(event.from), to: at(event.to) })
        : t("health.events.unreachableOpen", { from: at(event.from) });
    case "restart":
      return t("health.events.restart", { startedAt: at(event.startedAt) });
    case "version":
      return t("health.events.version", { from: event.from, to: event.to });
    case "tls":
      return t("health.events.tls");
  }
}

function eventAt(event: DbHealthEvent): string {
  return event.kind === "unreachable" ? event.from : event.at;
}

function Availability({
  label,
  value,
  format,
}: {
  label: string;
  value: number | null;
  format: DbFormat;
}) {
  return (
    <div className="rounded-lg border p-3" data-slot="availability">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">
        {value === null
          ? format.t("health.availability.none")
          : formatPercent(value, format.language, value < 1 ? 2 : 0)}
      </p>
    </div>
  );
}

/** The health section of the connection page. */
export function ConnectionHealthCard({
  connection,
  format,
}: {
  connection: DbConnection & { band?: DbBandHour[] };
  format: DbFormat;
}) {
  const { t } = format;
  const [range, setRange] = React.useState<HealthRange>("day");
  const days = HEALTH_RANGES[range];
  const history = useConnectionHealth(connection.id, days);
  const health = connection.health;
  const data = history.data;
  const points = data?.points ?? [];
  const rows = points.map((point) => ({
    at: point.at,
    mean: point.latencyMs,
    max: point.latencyMaxMs,
    used: point.connectionsUsed,
    limit: point.connectionsMax,
  }));
  const tick = (value: string) =>
    new Date(value).toLocaleString(format.language, {
      ...(days > 1 ? { day: "2-digit", month: "2-digit" } : {}),
      hour: "2-digit",
      minute: "2-digit",
    });
  const latencyConfig = {
    mean: { label: t("health.latency.mean"), color: "var(--chart-info)" },
    max: { label: t("health.latency.max"), color: "var(--chart-2)" },
  } satisfies ChartConfig;
  const connectionsConfig = {
    used: { label: t("health.connections.used"), color: "var(--chart-info)" },
    limit: { label: t("health.connections.max"), color: "var(--chart-muted)" },
  } satisfies ChartConfig;
  const maxLatency = Math.max(0, ...rows.map((row) => row.max ?? row.mean ?? 0));
  const maxConnections = Math.max(0, ...rows.map((row) => Math.max(row.used ?? 0, row.limit ?? 0)));
  const latencyTicks = countTicks(maxLatency);
  const connectionTicks = countTicks(maxConnections);
  const last = rows.at(-1);
  const empty = !history.isPending && rows.every((row) => row.mean === null && row.used === null);

  return (
    <section className="space-y-4" data-slot="connection-health" aria-labelledby="health-title">
      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle id="health-title" className="flex items-center gap-2">
              <Activity aria-hidden="true" className="size-4 text-muted-foreground" />
              {t("health.title")}
            </CardTitle>
            <CardDescription>
              {t("health.description", { count: health.intervalMinutes })}{" "}
              {t("health.notMonitoring")}
            </CardDescription>
          </div>
          <Tabs value={range} onValueChange={(value) => setRange(value as HealthRange)}>
            <TabsList aria-label={t("health.range.label")}>
              {(Object.keys(HEALTH_RANGES) as HealthRange[]).map((key) => (
                <TabsTrigger key={key} value={key}>
                  {t(`health.range.${key}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="space-y-4">
          <HealthNow connection={connection} format={format} />
          {connection.band ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t("health.band.label")}</span>
              <HealthBand band={connection.band} format={format} />
            </div>
          ) : null}
          {history.isError ? (
            <ErrorState
              title={t("health.loadError")}
              error={history.error}
              onRetry={() => void history.refetch()}
              retrying={history.isFetching}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              {history.isPending ? (
                <>
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                </>
              ) : (
                <>
                  <Availability
                    label={t("health.availability.day")}
                    value={data?.availability.day ?? null}
                    format={format}
                  />
                  <Availability
                    label={t("health.availability.week")}
                    value={data?.availability.week ?? null}
                    format={format}
                  />
                  <Availability
                    label={t("health.availability.month")}
                    value={data?.availability.month ?? null}
                    format={format}
                  />
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title={t("health.latency.title")}
          description={t("health.latency.description")}
          config={latencyConfig}
          loading={history.isPending}
          error={history.isError ? history.error : undefined}
          onRetry={() => void history.refetch()}
          empty={empty}
          emptyTitle={t("health.empty.title")}
          emptyDescription={t("health.empty.description")}
          chartClassName="h-56"
          summary={t("health.latency.summary", {
            last: formatLatency(last?.mean ?? null, format.language),
            max: formatLatency(maxLatency || null, format.language),
          })}
        >
          <LineChart data={rows} accessibilityLayer margin={{ left: 4, right: 4 }}>
            <CartesianGrid {...HORIZONTAL_GRID} />
            <XAxis dataKey="at" {...AXIS} minTickGap={32} tickFormatter={tick} />
            <YAxis
              {...AXIS}
              ticks={latencyTicks}
              domain={[0, latencyTicks.at(-1) ?? 1]}
              interval={VALUE_AXIS_INTERVAL}
              tickFormatter={(value: number) => formatLatency(value, format.language)}
              width={64}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => format.dateTime(String(value)) ?? String(value)}
                  formatter={(value, name) => (
                    <span className="flex w-full justify-between gap-4">
                      <span>{latencyConfig[name as keyof typeof latencyConfig]?.label}</span>
                      <span className="tabular-nums">
                        {formatLatency(Number(value), format.language)}
                      </span>
                    </span>
                  )}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Line
              dataKey="mean"
              type="linear"
              stroke="var(--color-mean)"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="max"
              type="linear"
              stroke="var(--color-max)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartCard>
        <ChartCard
          title={t("health.connections.title")}
          description={t("health.connections.description")}
          config={connectionsConfig}
          loading={history.isPending}
          error={history.isError ? history.error : undefined}
          onRetry={() => void history.refetch()}
          empty={empty}
          emptyTitle={t("health.empty.title")}
          emptyDescription={t("health.empty.description")}
          chartClassName="h-56"
          summary={t("health.connections.summary", {
            used: last?.used ?? "–",
            max: last?.limit ?? "–",
          })}
        >
          <LineChart data={rows} accessibilityLayer margin={{ left: 4, right: 4 }}>
            <CartesianGrid {...HORIZONTAL_GRID} />
            <XAxis dataKey="at" {...AXIS} minTickGap={32} tickFormatter={tick} />
            <YAxis
              {...AXIS}
              ticks={connectionTicks}
              domain={[0, connectionTicks.at(-1) ?? 1]}
              interval={VALUE_AXIS_INTERVAL}
              width={48}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => format.dateTime(String(value)) ?? String(value)}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Line
              dataKey="used"
              type="stepAfter"
              stroke="var(--color-used)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="limit"
              type="stepAfter"
              stroke="var(--color-limit)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartCard>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("health.events.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data?.lastError ? (
            <p className="text-sm text-muted-foreground" data-slot="health-last-error">
              {t("health.lastError", { at: format.dateTime(data.lastError.at) ?? "" })}
              {": "}
              {data.lastError.code ? t(codeKey(data.lastError.code)) : null}
              {data.lastError.message ? ` (${data.lastError.message})` : null}
            </p>
          ) : null}
          {data && data.events.length > 0 ? (
            <ol className="space-y-2 text-sm" data-slot="health-events">
              {data.events.map((event) => (
                <li
                  key={`${event.kind}-${eventAt(event)}`}
                  className="flex flex-wrap items-baseline gap-x-3"
                >
                  <time dateTime={eventAt(event)} className="text-muted-foreground tabular-nums">
                    {format.dateTime(eventAt(event))}
                  </time>
                  <span>{eventText(event, format)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">
              {history.isPending ? null : t("health.events.none")}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** The state of the checks now: last check, the run of failures, the alert. */
function HealthNow({ connection, format }: { connection: DbConnection; format: DbFormat }) {
  const { t } = format;
  const health = connection.health;
  if (!connection.enabled) {
    return <p className="text-sm text-muted-foreground">{t("health.now.paused")}</p>;
  }
  if (!health.lastAt) {
    return <p className="text-sm text-muted-foreground">{t("health.now.never")}</p>;
  }
  const view = reachabilityView(health.reachability);
  return (
    <div className="space-y-1 text-sm" data-slot="health-now">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={view.tone}>{t(view.key)}</StatusBadge>
        {health.consecutiveFailures > 0 && health.failingSince ? (
          <span className="flex items-center gap-1">
            <AlertTriangle aria-hidden="true" className="size-4 text-warning" />
            {t("health.now.failing", {
              count: health.consecutiveFailures,
              since: format.dateTime(health.failingSince) ?? "",
            })}
            {health.errorCode ? ` · ${t(codeKey(health.errorCode))}` : null}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {t("health.now.ok", {
              at: format.dateTime(health.lastAt) ?? "",
              latency: formatLatency(health.latencyMs, format.language),
            })}{" "}
            (<RelativeTime value={health.lastAt} />)
          </span>
        )}
      </div>
      {health.alerted ? <p className="text-muted-foreground">{t("health.now.alerted")}</p> : null}
    </div>
  );
}

/** The size of a database day by day (database page). */
export function DatabaseSizeCard({ databaseId, format }: { databaseId: string; format: DbFormat }) {
  const { t } = format;
  const sizes = useDatabaseSizes(databaseId, 30);
  const days = sizes.data?.days ?? [];
  const config = {
    sizeBytes: { label: t("size.series"), color: "var(--chart-1)" },
  } satisfies ChartConfig;
  const ticks = byteAxisTicks(Math.max(0, ...days.map((day) => day.sizeBytes)));
  const first = days[0];
  const last = days.at(-1);
  const change = first && last ? last.sizeBytes - first.sizeBytes : 0;
  const signed = (value: number) =>
    `${value > 0 ? "+" : value < 0 ? "−" : "±"}${format.bytes(Math.abs(value)) ?? ""}`;
  return (
    <ChartCard
      title={t("size.title")}
      description={t("size.description")}
      config={config}
      loading={sizes.isPending}
      error={sizes.isError ? sizes.error : undefined}
      onRetry={() => void sizes.refetch()}
      empty={!sizes.isPending && days.length === 0}
      emptyTitle={t("size.empty.title")}
      emptyDescription={t("size.empty.description")}
      chartClassName="h-56"
      summary={
        last
          ? t("size.summary", { last: format.bytes(last.sizeBytes) ?? "", change: signed(change) })
          : undefined
      }
      footer={
        last && last.growthBytes !== null ? (
          <span className="flex items-center gap-2">
            <HardDrive aria-hidden="true" className="size-4" />
            {t("size.growth")}: {signed(last.growthBytes)}
          </span>
        ) : null
      }
    >
      <LineChart data={days} accessibilityLayer margin={{ left: 4, right: 4 }}>
        <CartesianGrid {...HORIZONTAL_GRID} />
        <XAxis
          dataKey="day"
          {...AXIS}
          minTickGap={24}
          tickFormatter={(value: string) =>
            new Date(`${value}T00:00:00Z`).toLocaleDateString(format.language, {
              day: "2-digit",
              month: "2-digit",
              timeZone: "UTC",
            })
          }
        />
        <YAxis
          {...AXIS}
          ticks={ticks}
          domain={[0, ticks.at(-1) ?? 1]}
          interval={VALUE_AXIS_INTERVAL}
          tickFormatter={(value: number) => format.bytes(value) ?? ""}
          width={72}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => (
                <span className="tabular-nums">{format.bytes(Number(value))}</span>
              )}
            />
          }
        />
        <Line
          dataKey="sizeBytes"
          type="linear"
          stroke="var(--color-sizeBytes)"
          strokeWidth={2}
          dot={days.length < 3}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartCard>
  );
}
