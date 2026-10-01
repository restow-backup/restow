import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatBytes, formatInteger } from "@/lib/format";

import { STATS_NAMESPACE } from "./i18n.js";
import type { Granularity } from "./period.js";
import {
  axisLabel,
  formatDayRange,
  formatDecimal,
  formatDuration,
  formatShare,
  longLabel,
} from "./presenters.js";

/** Codes the server may send (reasons, kinds, states) are looked up only when they look like codes. */
const CODE = /^[A-Za-z0-9_-]+$/;

/**
 * Locale-bound formatters and code labels shared by the statistics
 * components. Codes this version does not know are shown as sent rather
 * than hidden.
 */
export function useStatsFormat() {
  const { t, i18n } = useTranslation(STATS_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;

  return React.useMemo(() => {
    /** The translation of `prefix.code` when there is one, else null. */
    const known = (prefix: string, code: string): string | null => {
      if (!CODE.test(code)) {
        return null;
      }
      const key = `${prefix}.${code}`;
      return typeof i18n.getResource(language, STATS_NAMESPACE, key) === "string" ? t(key) : null;
    };
    return {
      t,
      language,
      bytes: (value: number) => formatBytes(value, language),
      integer: (value: number) => formatInteger(value, language),
      share: (ratio: number) => formatShare(ratio, language),
      decimal: (value: number) => formatDecimal(value, language),
      duration: (seconds: number) => formatDuration(seconds, language),
      /** A change in percentage points, e.g. "2.5 pp". */
      points: (value: number) => t("kpi.points", { value: formatDecimal(value, language) }),
      axis: (value: string, granularity: Granularity) => axisLabel(value, granularity, language),
      /** A bucket in full for tooltips; weeks read "Week of …". */
      bucket: (value: string, granularity: Granularity) => {
        const label = longLabel(value, granularity, language);
        return granularity === "week" ? t("charts.weekOf", { date: label }) : label;
      },
      range: (firstDay: string, lastDay: string) => formatDayRange(firstDay, lastDay, language),
      granularity: (granularity: Granularity) => t(`period.granularity.${granularity}`),
      /** Why a dataset is unavailable, in words. */
      reason: (reason: string) => known("unavailable.reasons", reason) ?? reason,
      jobKind: (kind: string) => known("jobKinds", kind) ?? kind,
      objectKind: (kind: string) => known("objectKinds", kind) ?? kind,
      objectState: (state: string | null) =>
        state === null ? t("objectStates.none") : (known("objectStates", state) ?? state),
      readiness: (readiness: string | null) =>
        readiness === null ? t("readiness.unknown") : (known("readiness", readiness) ?? readiness),
    };
  }, [t, i18n, language]);
}

export type StatsFormat = ReturnType<typeof useStatsFormat>;
