import { type InstallationTimeZone, resolveInstallationTimeZone } from "@restow/core";
import { settings } from "@restow/db";
import type { DbExecutor } from "./tenant-context.js";

/**
 * The installation's time zone as it applies now: the one chosen in the setup wizard or under
 * Installation > Server, else `RESTOW_TIME_ZONE`, else `TZ`, else Europe/Berlin
 * (@restow/core `resolveInstallationTimeZone`). One indexed read of the single settings row.
 */
export async function loadInstallationTimeZone(
  db: DbExecutor,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<InstallationTimeZone> {
  const [row] = await db.select({ timeZone: settings.timeZone }).from(settings).limit(1);
  return resolveInstallationTimeZone(row?.timeZone ?? null, env);
}
