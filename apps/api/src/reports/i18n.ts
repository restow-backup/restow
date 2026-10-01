import { createI18n } from "@restow/i18n";
import reportsDe from "@restow/i18n/resources/de/reports.json" with { type: "json" };
import reportsEn from "@restow/i18n/resources/en/reports.json" with { type: "json" };
import type { ReportLanguage } from "./format.js";

/**
 * Report texts come from the `reports` translation namespace
 * (packages/i18n/resources/<lng>/reports.json) and are formatted with the
 * shared ICU setup, so plurals and wording follow the same rules as the web
 * app. The bundle is registered on the instance when the shared resource
 * list does not carry it, which keeps the reports working on their own.
 */

export type Translate = (key: string, values?: Record<string, unknown>) => string;

const REPORTS_NAMESPACE = "reports";
const BUNDLES: Record<ReportLanguage, Record<string, unknown>> = { de: reportsDe, en: reportsEn };

/** A translator for `reports:` keys (given without the namespace prefix). */
export function reportTranslator(language: ReportLanguage): Translate {
  const i18n = createI18n({ lng: language });
  if (!i18n.hasResourceBundle(language, REPORTS_NAMESPACE)) {
    i18n.addResourceBundle(language, REPORTS_NAMESPACE, BUNDLES[language], true, false);
  }
  return (key, values) => String(i18n.t(`${REPORTS_NAMESPACE}:${key}`, values));
}
