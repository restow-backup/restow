import type { JobSchedule } from "@restow/core";
import { type SupportedLanguage, createI18n, defaultLanguage } from "@restow/i18n";

/**
 * The names the system gives jobs it makes itself: the default mail job of a tenant and the jobs
 * the migration forms from machines ("Linux servers · daily 02:00"). The words are translations
 * (packages/i18n resources, namespace `backupjobs`, `auto.*`), the language is the tenant's.
 * An administrator renames them like any other job.
 */

const instances = new Map<SupportedLanguage, ReturnType<typeof createI18n>>();

type Translate = (key: string, values?: Record<string, string | number>) => string;

function translator(language: SupportedLanguage): Translate {
  let instance = instances.get(language);
  if (!instance) {
    instance = createI18n({ lng: language });
    instances.set(language, instance);
  }
  const fixed = instance;
  return (key, values) => String(fixed.t(key, values));
}

/** The language of a tenant's texts: its own, else the installation's default. */
export function languageOf(tenant: { language: "de" | "en" | null }): SupportedLanguage {
  return tenant.language ?? defaultLanguage;
}

export function mailJobName(language: SupportedLanguage): string {
  return translator(language)("backupjobs:auto.mailJob");
}

/** "daily 02:00", "every 4 h", "on connect, at most every 4 h". */
export function scheduleLabel(language: SupportedLanguage, schedule: JobSchedule): string {
  const t = translator(language);
  const hoursOrMinutes = (minutes: number, hoursKey: string, minutesKey: string) =>
    minutes % 60 === 0 ? t(hoursKey, { hours: minutes / 60 }) : t(minutesKey, { minutes });
  switch (schedule.kind) {
    case "daily":
      return t("backupjobs:auto.schedule.daily", { time: schedule.timeOfDay ?? "" });
    case "on_connect":
      return schedule.intervalMinutes
        ? hoursOrMinutes(
            schedule.intervalMinutes,
            "backupjobs:auto.schedule.onConnectHours",
            "backupjobs:auto.schedule.onConnectMinutes",
          )
        : t("backupjobs:auto.schedule.onConnect");
    default:
      return hoursOrMinutes(
        schedule.intervalMinutes ?? 0,
        "backupjobs:auto.schedule.intervalHours",
        "backupjobs:auto.schedule.intervalMinutes",
      );
  }
}

const KNOWN_OS = new Set(["linux", "darwin", "windows"]);

/** The name of the job formed from the machines of one group: "<system and profile> · <schedule>". */
export function endpointGroupName(
  language: SupportedLanguage,
  os: string,
  profile: "server" | "client",
  schedule: JobSchedule,
): string {
  const t = translator(language);
  const group = t(`backupjobs:auto.group.${KNOWN_OS.has(os) ? os : "linux"}.${profile}`);
  return t("backupjobs:auto.format", { group, schedule: scheduleLabel(language, schedule) });
}

/** `base`, or `base (2)`, `base (3)` ... the first that is not taken (compared without case). */
export function uniqueName(
  language: SupportedLanguage,
  base: string,
  taken: ReadonlySet<string>,
): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) {
    return base;
  }
  const t = translator(language);
  for (let number = 2; ; number++) {
    const candidate = t("backupjobs:auto.duplicate", { name: base, number });
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
