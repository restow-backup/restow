import { canonicalTimeZone } from "./cron.js";
import { DEFAULT_SCHEDULE_TIMEZONE } from "./defaults.js";

/**
 * The installation's time zone (0.4.2, docs/UPDATING.md "The installation's time zone"). Planned
 * updates are read in it, the updater's times are shown in it, and a new tenant starts with it.
 *
 * Where it comes from, first match wins:
 *
 *   settings     chosen in the setup wizard or under Installation > Server (`settings.time_zone`)
 *   environment  `RESTOW_TIME_ZONE` (installations set up before the setting existed)
 *   process      the process zone `TZ`
 *   default      Europe/Berlin, the zone the schedules default to
 *
 * A value that is not an IANA zone is skipped, so a typo in the environment never stops anything.
 */
export type InstallationTimeZoneSource = "settings" | "environment" | "process" | "default";

export interface InstallationTimeZone {
  timeZone: string;
  source: InstallationTimeZoneSource;
}

export function resolveInstallationTimeZone(
  stored: string | null | undefined,
  env: Readonly<Record<string, string | undefined>>,
): InstallationTimeZone {
  const candidates: [string | null | undefined, InstallationTimeZoneSource][] = [
    [stored, "settings"],
    [env.RESTOW_TIME_ZONE, "environment"],
    [env.TZ, "process"],
  ];
  for (const [candidate, source] of candidates) {
    const zone = candidate ? canonicalTimeZone(candidate) : null;
    if (zone) {
      return { timeZone: zone, source };
    }
  }
  return { timeZone: DEFAULT_SCHEDULE_TIMEZONE, source: "default" };
}

/** The zone the installation would use without a choice of its own (environment, else default). */
export function environmentTimeZone(
  env: Readonly<Record<string, string | undefined>>,
): InstallationTimeZone {
  return resolveInstallationTimeZone(null, env);
}
