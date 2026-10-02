import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { type ReadinessState, verifyLink } from "@/features/verify/search";
import { formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { StatusTone } from "@/components/kit";
import type { ReadinessSegmentKey } from "../presenters.js";
import "../i18n.js";

/** The fill of each tone in the breakdown bar and its legend (shared with the endpoints card). */
export const SEGMENT_FILL = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
  info: "bg-info",
  neutral: "bg-foreground",
} as const;

/** The objects by state, as the readiness tile counts them. */
export interface ReadinessCounts {
  total: number;
  green: number;
  yellow: number;
  red: number;
  unverified: number;
  noBackup: number;
}

/**
 * The legend of the readiness tile, in the order of the recovery-readiness
 * page's filter: what is proven first, what cannot be restored third. Each row
 * names the `state` of the address it links to (`/verify?state=...`).
 */
export const READINESS_LEGEND: readonly {
  key: ReadinessSegmentKey;
  state: ReadinessState;
  tone: StatusTone;
}[] = [
  { key: "green", state: "green", tone: "success" },
  { key: "yellow", state: "yellow", tone: "warning" },
  { key: "red", state: "red", tone: "destructive" },
  { key: "unverified", state: "unverified", tone: "warning" },
  { key: "noBackup", state: "no_backup", tone: "destructive" },
];

/** The count of a legend row. */
export function legendCount(counts: ReadinessCounts, key: ReadinessSegmentKey): number {
  return counts[key];
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
}: {
  counts: ReadinessCounts;
  scope: "tenant" | "all";
  linkable: boolean;
}) {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <ul
      aria-label={t("readiness.legend")}
      className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-sm sm:grid-cols-2"
    >
      {READINESS_LEGEND.map(({ key, state, tone }) => {
        const count = legendCount(counts, key);
        const label = t(`readiness.segments.${key}`);
        const row = (
          <>
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", SEGMENT_FILL[tone])}
            />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="font-medium tabular-nums">{formatInteger(count, language)}</span>
          </>
        );
        return (
          <li key={key} data-segment={key} data-state={state}>
            {linkable && count > 0 ? (
              <Link
                {...verifyLink(state, scope === "all" ? "all" : undefined)}
                title={t("readiness.open", { count, label })}
                className="group -mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {row}
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              </Link>
            ) : (
              <span
                className={cn(
                  "-mx-2 flex items-center gap-2 px-2 py-1.5",
                  count === 0 && "text-muted-foreground",
                )}
              >
                {row}
                {/* Keeps the figures of linked and plain rows in one column. */}
                <span aria-hidden="true" className="size-3.5 shrink-0" />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The share of the objects, as one bar; only the states that have objects. */
export function ReadinessBar({ counts }: { counts: ReadinessCounts }) {
  const segments = (
    [
      ["red", counts.red, "destructive"],
      ["noBackup", counts.noBackup, "destructive"],
      ["unverified", counts.unverified, "warning"],
      ["yellow", counts.yellow, "warning"],
      ["green", counts.green, "success"],
    ] as const
  ).filter(([, count]) => count > 0);
  return (
    <div
      className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
      aria-hidden="true"
    >
      {segments.map(([key, count, tone]) => (
        <div
          key={key}
          className={cn("h-full", SEGMENT_FILL[tone])}
          style={{ width: `${(count / Math.max(1, counts.total)) * 100}%` }}
        />
      ))}
    </div>
  );
}
