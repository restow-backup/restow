import { type SupportedLanguage, createI18n, defaultLanguage } from "@restow/i18n";

/**
 * The name of the default mail job the scheduler makes for a tenant, in the tenant's language
 * (packages/i18n, namespace `backupjobs`, `auto.*`: the same words the api names its own jobs
 * with). An administrator renames it like any other job.
 */

const instances = new Map<SupportedLanguage, ReturnType<typeof createI18n>>();

function translator(language: SupportedLanguage) {
  let instance = instances.get(language);
  if (!instance) {
    instance = createI18n({ lng: language });
    instances.set(language, instance);
  }
  return instance;
}

/** The language of a tenant's texts: its own, else the installation's default. */
export function languageOf(language: string | null): SupportedLanguage {
  return language === "de" || language === "en" ? language : defaultLanguage;
}

/** "Mail backup" (or the translation), `... (2)` and so on until it is free (compared without case). */
export function defaultMailJobName(
  language: SupportedLanguage,
  taken: ReadonlySet<string>,
): string {
  const t = translator(language);
  const base = String(t.t("backupjobs:auto.mailJob"));
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  for (let number = 2; ; number++) {
    const candidate = String(t.t("backupjobs:auto.duplicate", { name: base, number }));
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
