import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatDateTime, formatRelative } from "@/lib/format";

/** Locale-bound time formatting for the integrations pages. */
export function useIntegrationsFormat() {
  const { t, i18n } = useTranslation("integrations");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useMemo(
    () => ({
      t,
      language,
      relative: (value: string | null) => formatRelative(value, language),
      dateTime: (value: string | null) => formatDateTime(value, language),
    }),
    [t, language],
  );
}
