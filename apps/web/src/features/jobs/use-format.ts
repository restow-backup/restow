import * as React from "react";
import { useTranslation } from "react-i18next";

import type { JobQueue, JobStatus, ObjectKind } from "@/features/jobs/api";
import { durationParts, phaseLabel } from "@/features/jobs/presenters";
import { formatBytes, formatDateTime, formatInteger, formatRelative } from "@/lib/format";

/**
 * Locale-bound formatters for the jobs pages, so every component says the
 * same thing the same way (units, durations, phase and status names).
 */
export function useJobFormat() {
  const { t, i18n } = useTranslation("backup");
  const language = i18n.resolvedLanguage ?? i18n.language;

  return React.useMemo(
    () => ({
      t,
      language,
      duration(seconds: number): string {
        const { key, values } = durationParts(seconds);
        return t(key, values);
      },
      bytes: (value: number) => formatBytes(value, language),
      integer: (value: number) => formatInteger(value, language),
      relative: (value: string | null) => formatRelative(value, language),
      dateTime: (value: string | null) => formatDateTime(value, language),
      phase(name: string): string {
        const { key, values } = phaseLabel(name);
        return t(key, values);
      },
      queue: (queue: JobQueue) => t(`queue.${queue}`),
      status: (status: JobStatus) => t(`jobStatus.${status}`),
      kind: (kind: ObjectKind) => t(`kind.${kind}`),
    }),
    [t, language],
  );
}

export type JobFormat = ReturnType<typeof useJobFormat>;
