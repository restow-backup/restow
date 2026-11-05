import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  READINESS_BAR_ORDER,
  READINESS_CATEGORY_META,
  READINESS_TILE_ORDER,
  type ReadinessObjectState,
  StatusIcon,
  type StatusMeta,
  StatusSegment,
} from "@/components/kit";
import { type TableFilter, verifyLink } from "@/features/verify/search";
import { formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ReadinessSegmentKey } from "../presenters.js";
import "../i18n.js";

/** The objects by state, as the readiness tile counts them. */
export interface ReadinessCounts {
  total: number;
  green: number;
  yellow: number;
  red: number;
  unverified: number;
  noBackup: number;
  /** Confirmed as empty (one tenant's view only; absent from an older server). */
  empty?: number;
}

/** The legend key (a count of {@link ReadinessCounts}) of each object state. */
const SEGMENT_KEY: Readonly<Record<ReadinessObjectState, ReadinessSegmentKey>> = {
  green: "green",
  yellow: "yellow",
  red: "red",
  unverified: "unverified",
  no_backup: "noBackup",
  empty: "empty",
};

/**
 * The legend of the readiness tile: the five categories in the order of the overview's tiles
 * (Ready, Needs attention, Unverified, Not restorable, No backup yet), then Confirmed empty
 * while there are some. Each row names the `state` of the address it links to
 * (`/verify?state=...`); severity, label and icon come from the status meta.
 */
export const READINESS_LEGEND: readonly {
  key: ReadinessSegmentKey;
  state: TableFilter;
  meta: StatusMeta;
}[] = [...READINESS_TILE_ORDER, "empty" as const].map((state) => ({
  key: SEGMENT_KEY[state],
  state,
  meta: READINESS_CATEGORY_META[state],
}));

/** The count of a legend row. */
export function legendCount(counts: ReadinessCounts, key: ReadinessSegmentKey): number {
  return counts[key] ?? 0;
}

/**
 * Every legend row is a link to Recovery readiness in that state: the table of
 * exactly those objects (`scope: "all"`: the tenants that have them). A row with
 * none is plain text, and so is every row where the viewer may not open
 * Recovery readiness (`linkable` false).
 */
export function ReadinessLegend({
  counts,
  scope,
  linkable,
  label,
}: {
  counts: ReadinessCounts;
  scope: "tenant" | "all";
  linkable: boolean;
  /** The list's accessible name; "Objects by recovery state" by default. */
  label?: string;
}) {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <ul
      aria-label={label ?? t("readiness.legend")}
      className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-sm sm:grid-cols-2"
    >
      {READINESS_LEGEND.filter(({ key }) => key !== "empty" || legendCount(counts, key) > 0).map(
        ({ key, state, meta }) => {
          const count = legendCount(counts, key);
          const empty = count === 0;
          const rowLabel = t(meta.labelKey);
          const row = (
            <>
              <StatusIcon meta={meta} dimmed={empty} />
              <span className="min-w-0 flex-1 truncate">{rowLabel}</span>
              <span className="font-medium tabular-nums">{formatInteger(count, language)}</span>
            </>
          );
          return (
            <li
              key={key}
              data-segment={key}
              data-state={state}
              data-severity={meta.severity}
              data-empty={empty ? "true" : undefined}
            >
              {linkable && !empty ? (
                <Link
                  {...verifyLink(state, scope === "all" ? "all" : undefined)}
                  title={t("readiness.open", { count, label: rowLabel })}
                  className="group -mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {row}
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                </Link>
              ) : (
                // A category with nothing in it is dimmed and never a link (UI rework, phase 1).
                <span
                  className={cn(
                    "-mx-2 flex items-center gap-2 px-2 py-1.5",
                    empty && "text-muted-foreground",
                  )}
                >
                  {row}
                  {/* Keeps the figures of linked and plain rows in one column. */}
                  <span aria-hidden="true" className="size-3.5 shrink-0" />
                </span>
              )}
            </li>
          );
        },
      )}
    </ul>
  );
}

/**
 * The share of the objects, as one bar, worst first; only the states that have objects.
 * Unverified is hatched, so it reads apart from Needs attention without its colour.
 */
export function ReadinessBar({ counts }: { counts: ReadinessCounts }) {
  const total = Math.max(1, counts.total);
  return (
    <div
      className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
      aria-hidden="true"
      data-slot="readiness-bar"
    >
      {READINESS_BAR_ORDER.map((state) => {
        const count = legendCount(counts, SEGMENT_KEY[state]);
        return count > 0 ? (
          <StatusSegment key={state} meta={READINESS_CATEGORY_META[state]} width={count / total} />
        ) : null;
      })}
    </div>
  );
}
