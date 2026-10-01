import { CalendarRange } from "lucide-react";
import * as React from "react";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { useIsMobile } from "@/components/ui/hooks/use-mobile";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import {
  PERIOD_PRESETS,
  type PeriodPreset,
  type ResolvedPeriod,
  type StatsSearch,
  dayStart,
  toDay,
  withCustomRange,
  withPreset,
} from "../period.js";
import { useStatsFormat } from "../use-stats-format.js";

interface PeriodSelectorProps {
  search: StatsSearch;
  period: ResolvedPeriod;
  onChange: (next: StatsSearch) => void;
}

/**
 * The period of the page: four presets as a toggle group (arrow keys move
 * between them) and a custom range from the calendar in a popover. The
 * choice goes to the URL; the bucket size follows the range.
 */
export function PeriodSelector({ search, period, onChange }: PeriodSelectorProps) {
  const format = useStatsFormat();
  const { t } = format;

  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">{t("period.label")}</legend>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={period.choice === "custom" ? "" : period.choice}
        onValueChange={(value) => {
          // Radix sends "" when the pressed item is pressed again; the period stays.
          if (value) {
            onChange(withPreset(search, value as PeriodPreset));
          }
        }}
        aria-label={t("period.presetsLabel")}
      >
        {PERIOD_PRESETS.map((preset) => (
          <ToggleGroupItem key={preset} value={preset} className="tabular-nums">
            {t(`period.presets.${preset}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <CustomRange search={search} period={period} onChange={onChange} />
    </fieldset>
  );
}

function CustomRange({ search, period, onChange }: PeriodSelectorProps) {
  const format = useStatsFormat();
  const { t } = format;
  const mobile = useIsMobile();
  const [open, setOpen] = React.useState(false);
  const active = period.choice === "custom";
  const current = React.useMemo<DateRange>(
    () => ({ from: dayStart(period.firstDay), to: dayStart(period.lastDay) }),
    [period.firstDay, period.lastDay],
  );
  const [draft, setDraft] = React.useState<DateRange | undefined>(current);
  const today = dayStart(toDay(new Date()));
  const lastDay = dayStart(period.lastDay);

  const onOpenChange = (next: boolean) => {
    // Every opening starts from the period on screen.
    if (next) {
      setDraft(current);
    }
    setOpen(next);
  };

  const complete = draft?.from !== undefined && draft.to !== undefined;
  const apply = () => {
    if (draft?.from && draft.to) {
      onChange(withCustomRange(search, draft.from, draft.to));
      setOpen(false);
    }
  };

  const rangeLabel = format.range(period.firstDay, period.lastDay);
  const draftLabel =
    draft?.from && draft.to
      ? format.range(toDay(draft.from), toDay(draft.to))
      : draft?.from
        ? t("period.pickEnd")
        : t("period.pickStart");

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-active={active || undefined}
          className={cn(
            "tabular-nums",
            active && "bg-accent text-accent-foreground dark:bg-accent dark:hover:bg-accent/80",
          )}
          aria-label={active ? t("period.customActive", { range: rangeLabel }) : undefined}
        >
          <CalendarRange aria-hidden="true" />
          {active ? rangeLabel : t("period.custom")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="space-y-1 border-b px-4 py-3">
          <p className="text-sm font-medium">{t("period.customTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("period.customHint")}</p>
        </div>
        <Calendar
          mode="range"
          selected={draft}
          onSelect={setDraft}
          // A click on a complete range starts a new one: first day, then last day.
          resetOnSelect
          numberOfMonths={mobile ? 1 : 2}
          // The end of the period is in view (the right-hand month on wide screens).
          defaultMonth={new Date(lastDay.getFullYear(), lastDay.getMonth() - (mobile ? 0 : 1), 1)}
          endMonth={today}
          disabled={{ after: today }}
          autoFocus
        />
        <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
            {draftLabel}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("period.cancel")}
            </Button>
            <Button size="sm" onClick={apply} disabled={!complete}>
              {t("period.apply")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
