import { useTranslation } from "react-i18next";

import { formatDateTime, formatInteger, formatRelative } from "@/lib/format";
import { failedStepKey, probeSummary } from "../presenters";
import type { ProbeResult as Probe } from "../types";
import { ToneLine } from "./status";

/**
 * What a storage probe found: on success the time each step took, on failure
 * the step it stopped at, the classified reason and the storage's own words.
 * Warnings (a container-only directory, plain HTTP) are shown either way.
 */
export function ProbeResult({ probe, compact = false }: { probe: Probe; compact?: boolean }) {
  const { t, i18n } = useTranslation("storage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const summary = probeSummary(probe);
  const stepKey = failedStepKey(probe);
  const testedAt = formatRelative(probe.checkedAt, language);

  return (
    <div className="space-y-2">
      <ToneLine tone={summary.tone}>
        <span className="font-medium">{t(summary.key, summary.values)}</span>
        {stepKey ? (
          <span className="text-muted-foreground">
            {" "}
            {t("health.failedAt", { step: t(stepKey) })}
          </span>
        ) : null}
      </ToneLine>

      {probe.ok ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 pl-5.5 text-xs text-muted-foreground">
          {probe.steps.map((step) => (
            <li key={step.step} className="tabular-nums">
              {t("health.stepDuration", {
                step: t(`health.steps.${step.step}`),
                ms: formatInteger(step.durationMs, language),
              })}
            </li>
          ))}
        </ul>
      ) : probe.error ? (
        <p className="break-words pl-5.5 font-mono text-xs text-muted-foreground">
          {t("health.detail", { message: probe.error })}
        </p>
      ) : null}

      {probe.warnings.map((warning) => (
        <ToneLine key={warning} tone="warning" className="text-xs">
          {t(`health.warnings.${warning}`)}
        </ToneLine>
      ))}

      {!compact && testedAt ? (
        <p
          className="pl-5.5 text-xs text-muted-foreground"
          title={formatDateTime(probe.checkedAt, language) ?? undefined}
        >
          {t("health.testedAt", { when: testedAt })}
        </p>
      ) : null}
    </div>
  );
}
