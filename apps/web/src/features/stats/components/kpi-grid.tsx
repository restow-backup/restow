import {
  ArchiveRestore,
  CircleX,
  Database,
  HardDrive,
  Hourglass,
  Layers,
  type LucideIcon,
  Percent,
  ShieldCheck,
  SquareCheckBig,
} from "lucide-react";

import { type KpiDelta, KpiTile } from "@/components/kit";

import type { KpiName, StatsOverview } from "../api.js";
import {
  KPI_SPECS,
  type KpiFormat,
  type KpiSpec,
  dedupFigures,
  dedupUnavailableReason,
  kpiChange,
} from "../presenters.js";
import { type StatsFormat, useStatsFormat } from "../use-stats-format.js";

const KPI_ICONS: Readonly<Record<KpiName | "dedup", LucideIcon>> = {
  backupSuccessRate: ShieldCheck,
  failedItems: CircleX,
  verifiedShare: SquareCheckBig,
  protectedObjects: Layers,
  restores: ArchiveRestore,
  throttlingWaitSeconds: Hourglass,
  logicalBytes: Database,
  physicalBytes: HardDrive,
  dedupRatio: Percent,
  dedup: Percent,
};

function formatValue(value: number, kind: KpiFormat, format: StatsFormat): string {
  switch (kind) {
    case "share":
      return format.share(value);
    case "bytes":
      return format.bytes(value);
    case "duration":
      return format.duration(value);
    default:
      return format.integer(value);
  }
}

/** The change in the tile's unit: points for shares, bytes, durations or counts. */
function formatChange(absolute: number, kind: KpiFormat, format: StatsFormat): string {
  return kind === "share" ? format.points(absolute) : formatValue(absolute, kind, format);
}

/** A value that is not there: a dash for the eye, words for screen readers. */
function NoValue({ label }: { label: string }) {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">
        —
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
}

interface KpiGridProps {
  /** Undefined while the figures load. */
  kpis: StatsOverview["kpis"] | undefined;
}

/**
 * The key figures of the period, three per row: protection, operations,
 * volume. Every tile compares with the previous period of the same length
 * (named once on the page, read out with each change); a figure without a
 * source says so and why, instead of showing a zero.
 */
export function KpiGrid({ kpis }: KpiGridProps) {
  const format = useStatsFormat();
  const { t } = format;

  const tile = (spec: KpiSpec) => {
    const label = t(`kpi.${spec.name}.label`);
    const icon = KPI_ICONS[spec.name];
    if (!kpis) {
      return <KpiTile key={spec.name} label={label} icon={icon} value="" loading />;
    }
    const kpi = kpis[spec.name];
    if (kpi.status === "unavailable") {
      return (
        <KpiTile
          key={spec.name}
          label={label}
          icon={icon}
          value={<NoValue label={t("unavailable.title")} />}
          hint={format.reason(kpi.reason)}
        />
      );
    }
    const change = kpiChange(kpi, spec.format);
    const delta: KpiDelta | null =
      change === null
        ? null
        : {
            value: change,
            higherIsBetter: spec.higherIsBetter,
            format: (absolute) => formatChange(absolute, spec.format, format),
          };
    return (
      <KpiTile
        key={spec.name}
        label={label}
        icon={icon}
        value={
          kpi.value === null ? (
            <NoValue label={t("kpi.none")} />
          ) : (
            formatValue(kpi.value, spec.format, format)
          )
        }
        delta={delta}
        hint={kpi.value === null ? t("kpi.none") : t(`kpi.${spec.name}.hint`)}
      />
    );
  };

  return (
    <div className="grid grid-cols-1 gap-4 *:min-w-0 sm:grid-cols-2 lg:grid-cols-3">
      {KPI_SPECS.map(tile)}
      <DedupTile kpis={kpis} />
    </div>
  );
}

function DedupTile({ kpis }: KpiGridProps) {
  const format = useStatsFormat();
  const { t } = format;
  const label = t("kpi.dedup.label");
  const icon = KPI_ICONS.dedup;
  if (!kpis) {
    return <KpiTile label={label} icon={icon} value="" loading />;
  }
  const figures = dedupFigures(kpis);
  if (!figures || figures.savings === null) {
    const reason = dedupUnavailableReason(kpis);
    return (
      <KpiTile
        label={label}
        icon={icon}
        value={<NoValue label={reason ? t("unavailable.title") : t("kpi.none")} />}
        hint={reason ? format.reason(reason) : t("kpi.dedup.hintNone")}
      />
    );
  }
  const change =
    figures.previousSavings === null
      ? null
      : Math.round((figures.savings - figures.previousSavings) * 1000) / 10;
  return (
    <KpiTile
      label={label}
      icon={icon}
      value={format.share(figures.savings)}
      delta={
        change === null
          ? null
          : {
              value: change,
              higherIsBetter: true,
              format: (absolute) => format.points(absolute),
            }
      }
      hint={
        figures.factor === null
          ? t("kpi.dedup.hintNone")
          : t("kpi.dedup.hint", { factor: format.decimal(figures.factor) })
      }
    />
  );
}
