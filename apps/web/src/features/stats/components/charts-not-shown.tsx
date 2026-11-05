import type { StatsOverview } from "../api.js";
import { absentCharts } from "../presenters.js";
import { useStatsFormat } from "../use-stats-format.js";

/**
 * The charts of the period that have nothing to draw, named in a few lines under the others
 * instead of standing as empty cards: what is missing and why (nothing happened in the period,
 * or the server has no source for it). Nothing while the figures load or when every chart draws.
 */
export function ChartsNotShown({ series }: { series: StatsOverview["series"] | undefined }) {
  const format = useStatsFormat();
  const { t } = format;
  const absent = absentCharts(series);
  if (absent.length === 0) {
    return null;
  }
  return (
    <div data-slot="charts-not-shown" className="space-y-1 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{t("charts.notShown.title")}</p>
      <ul className="space-y-0.5">
        {absent.map(({ name, absence }) => (
          <li key={name} data-chart={name} data-reason={absence.kind}>
            <span className="font-medium text-foreground">{t(`charts.${name}.title`)}</span>
            {": "}
            {absence.kind === "unavailable"
              ? format.reason(absence.reason)
              : t(`charts.${name}.empty.description`)}
          </li>
        ))}
      </ul>
    </div>
  );
}
