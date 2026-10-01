import { type LucideIcon, Minus, TrendingDown, TrendingUp } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { UI_NAMESPACE } from "./i18n.js";

export type DeltaDirection = "up" | "down" | "flat";
export type DeltaTone = "positive" | "destructive" | "muted";

export interface DeltaView {
  direction: DeltaDirection;
  /**
   * The text colour for good news, red for bad news, grey for no change or no
   * judgement. Good news is not green: green means a passed restore check
   * (brand guide, section 4), and a figure that moved the right way is not one.
   * The arrow, the sign and the sentence for screen readers say which way it went.
   */
  tone: DeltaTone;
  /** "+", the typographic minus "−", or nothing for no change. */
  sign: string;
  /** i18n key (namespace `ui`) of the screen-reader sentence. */
  sentenceKey: string;
}

const SENTENCE_KEYS = {
  upBetter: "kpi.change.upBetter",
  upWorse: "kpi.change.upWorse",
  upNeutral: "kpi.change.upNeutral",
  downBetter: "kpi.change.downBetter",
  downWorse: "kpi.change.downWorse",
  downNeutral: "kpi.change.downNeutral",
  flat: "kpi.change.flat",
} as const;

/** Every sentence key a delta can use (for the translation check). */
export const DELTA_SENTENCE_KEYS: readonly string[] = Object.values(SENTENCE_KEYS);

/**
 * Direction, tone and sign of a change. `higherIsBetter` says whether a rise
 * is good news (restored items: yes; failed jobs: no); `null` means neither
 * direction is good or bad (for example the number of protected mailboxes).
 */
export function describeDelta(value: number, higherIsBetter: boolean | null = true): DeltaView {
  if (!Number.isFinite(value) || value === 0) {
    return { direction: "flat", tone: "muted", sign: "", sentenceKey: SENTENCE_KEYS.flat };
  }
  const direction: DeltaDirection = value > 0 ? "up" : "down";
  const sign = value > 0 ? "+" : "−";
  if (higherIsBetter === null) {
    return {
      direction,
      tone: "muted",
      sign,
      sentenceKey: direction === "up" ? SENTENCE_KEYS.upNeutral : SENTENCE_KEYS.downNeutral,
    };
  }
  const better = (direction === "up") === higherIsBetter;
  const sentenceKey =
    direction === "up"
      ? better
        ? SENTENCE_KEYS.upBetter
        : SENTENCE_KEYS.upWorse
      : better
        ? SENTENCE_KEYS.downBetter
        : SENTENCE_KEYS.downWorse;
  return { direction, tone: better ? "positive" : "destructive", sign, sentenceKey };
}

const TONE_CLASS: Readonly<Record<DeltaTone, string>> = {
  positive: "text-foreground",
  destructive: "text-destructive-text",
  muted: "text-muted-foreground",
};

const DIRECTION_ICON: Readonly<Record<DeltaDirection, LucideIcon>> = {
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
};

export interface KpiDelta {
  /** Signed change against the comparison period, e.g. 12 or -3. */
  value: number;
  /** Formats the absolute change, e.g. as a percentage; plain number by default. */
  format?: (absolute: number) => string;
  /** Whether a rise is good news (default); `null` for no judgement. */
  higherIsBetter?: boolean | null;
  /** The comparison, e.g. "compared with last week"; shown and read out. */
  period?: string;
}

export interface KpiTileProps {
  label: string;
  /** The formatted value, e.g. "1,284" or "2.4 TB". */
  value: React.ReactNode;
  icon?: LucideIcon;
  delta?: KpiDelta | null;
  /** One short line of context under the value. */
  hint?: React.ReactNode;
  /** A small chart under the value (for example a recharts sparkline). */
  sparkline?: React.ReactNode;
  /** A router link to the details, e.g. "View jobs". */
  link?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

/**
 * A key figure: label, value in tabular numbers, an optional change with
 * arrow, sign and colour (plus a full sentence for screen readers), a hint,
 * a sparkline and a link to the details. Loading shows value-shaped skeletons
 * so the grid does not shift.
 */
export function KpiTile({
  label,
  value,
  icon: Icon,
  delta,
  hint,
  sparkline,
  link,
  loading = false,
  className,
}: KpiTileProps) {
  const { t } = useTranslation(UI_NAMESPACE);

  return (
    <Card data-slot="kpi-tile" className={cn("gap-3 p-4", className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {Icon ? (
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : null}
      </div>
      {loading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-4 w-36" />
          <span className="sr-only">{t("kpi.loading")}</span>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
          {delta ? <Delta delta={delta} /> : null}
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      )}
      {sparkline && !loading ? <div className="h-10 w-full">{sparkline}</div> : null}
      {link ? <div className="mt-auto text-sm">{link}</div> : null}
    </Card>
  );
}

function Delta({ delta }: { delta: KpiDelta }) {
  const { t, i18n } = useTranslation(UI_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const view = describeDelta(delta.value, delta.higherIsBetter);
  const absolute = Math.abs(Number.isFinite(delta.value) ? delta.value : 0);
  const change = delta.format
    ? delta.format(absolute)
    : new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(absolute);
  const period = delta.period ?? t("kpi.previousPeriod");
  const Arrow = DIRECTION_ICON[view.direction];

  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs">
      <span
        aria-hidden="true"
        data-tone={view.tone}
        className={cn(
          "inline-flex items-center gap-0.5 font-medium tabular-nums",
          TONE_CLASS[view.tone],
        )}
      >
        <Arrow className="size-3.5" />
        {view.sign}
        {change}
      </span>
      {delta.period ? (
        <span aria-hidden="true" className="text-muted-foreground">
          {delta.period}
        </span>
      ) : null}
      <span className="sr-only">{t(view.sentenceKey, { change, period })}</span>
    </p>
  );
}
