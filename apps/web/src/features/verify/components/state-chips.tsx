import { useTranslation } from "react-i18next";

import { READINESS_LEGEND, SEGMENT_FILL } from "@/features/dashboard/components/readiness-legend";
import {
  EMPTY_FILTERS,
  type EmptyFilter,
  READINESS_STATES,
  type ReadinessState,
  type TableFilter,
} from "@/features/verify/search";
import { formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";

import "@/features/verify/i18n";

/**
 * The filter chips of Recovery readiness: "All" and one chip per state, each with its
 * count. Choosing one sets the address (`?state=`), so a filtered table can be linked,
 * bookmarked and reached from the overview. The dots carry the colours of the
 * overview's readiness tile the chips continue from; the words say the state.
 */

export type StateCounts = Readonly<Record<ReadinessState, number>>;

/** Zero in every state. */
export const NO_STATES: StateCounts = {
  green: 0,
  yellow: 0,
  red: 0,
  unverified: 0,
  no_backup: 0,
};

/** The counts of a readiness summary, keyed by the states of the address. */
export function countsOfSummary(summary: {
  green: number;
  yellow: number;
  red: number;
  unverified: number;
  noBackup: number;
}): StateCounts {
  return {
    green: summary.green,
    yellow: summary.yellow,
    red: summary.red,
    unverified: summary.unverified,
    no_backup: summary.noBackup,
  };
}

/** Tone of the dot of the empty filters: yellow while unconfirmed, grey once confirmed. */
const EMPTY_TONE: Record<EmptyFilter, "warning" | "muted"> = {
  empty_unconfirmed: "warning",
  empty: "muted",
};

export function StateChips<T extends ReadinessState | TableFilter = ReadinessState>({
  counts,
  total,
  value,
  onChange,
  emptyCounts,
  className,
}: {
  counts: StateCounts;
  /** The number behind "All". */
  total: number;
  /** The state the table is filtered to; undefined shows everything. */
  value: T | undefined;
  onChange: (state: T | undefined) => void;
  /**
   * One tenant's table only: the objects found empty and not confirmed yet, and the ones
   * confirmed as empty. Each chip shows while it has objects or is chosen.
   */
  emptyCounts?: Readonly<Record<EmptyFilter, number>>;
  className?: string;
}) {
  const { t, i18n } = useTranslation("verify");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const count = (n: number) => formatInteger(n, language);
  return (
    <fieldset
      data-slot="state-chips"
      className={cn("m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0", className)}
    >
      <legend className="sr-only">{t("chips.label")}</legend>
      <Chip pressed={value === undefined} onClick={() => onChange(undefined)} data-state="all">
        {t("chips.all")}
        <Figure>{count(total)}</Figure>
      </Chip>
      {READINESS_STATES.map((state) => {
        const tone = READINESS_LEGEND.find((row) => row.state === state)?.tone ?? "muted";
        return (
          <Chip
            key={state}
            pressed={value === state}
            onClick={() => onChange((value === state ? undefined : state) as T | undefined)}
            data-state={state}
          >
            <span
              aria-hidden="true"
              className={cn("size-2 shrink-0 rounded-full", SEGMENT_FILL[tone])}
            />
            {t(`state.${state}`)}
            <Figure>{count(counts[state])}</Figure>
          </Chip>
        );
      })}
      {emptyCounts
        ? EMPTY_FILTERS.filter((filter) => emptyCounts[filter] > 0 || value === filter).map(
            (filter) => (
              <Chip
                key={filter}
                pressed={value === filter}
                onClick={() => onChange((value === filter ? undefined : filter) as T | undefined)}
                data-state={filter}
              >
                <span
                  aria-hidden="true"
                  className={cn("size-2 shrink-0 rounded-full", SEGMENT_FILL[EMPTY_TONE[filter]])}
                />
                {t(`chips.${filter}`)}
                <Figure>{count(emptyCounts[filter])}</Figure>
              </Chip>
            ),
          )
        : null}
    </fieldset>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs text-muted-foreground tabular-nums">{children}</span>;
}

function Chip({
  pressed,
  onClick,
  children,
  ...props
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  "data-state": string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors",
        "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
        pressed && "border-primary/40 bg-primary/10 text-primary [&_span]:text-primary",
      )}
      {...props}
    >
      {children}
    </button>
  );
}
