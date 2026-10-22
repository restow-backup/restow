import { type Database, type License, license } from "@restow/db";
import { desc, eq } from "drizzle-orm";
import { type Capability, hasCapability } from "./capabilities.js";
import {
  type EffectiveLicense,
  environmentEdition,
  type LicenseEdition,
  resolveEffectiveLicense,
} from "./editions.js";
import { runningBuildOf, type UpdateTerms, updateEntitlement } from "./entitlement.js";

/**
 * The installed license as the ee/ modules of every process read it: the
 * active row of the installation-level `license` table (no tenant, no Row
 * Level Security; read on the installation pool), else the environment's
 * edition (./editions.ts `environmentEdition`). Only verified terms are ever
 * stored (ee/api/src/license/service.ts), so the row is trusted as it is.
 * Read per call: installing or removing a key takes effect at once.
 *
 * One exception to "an installed key's edition is in effect": an operator who
 * started a release the installed key does not cover (its update period ended
 * before the release) with `RESTOW_RUN_AS_COMMUNITY=1` runs it as Community
 * (./startup-check.ts). Nothing is deleted or changed; a key that covers the
 * release brings the edition back at once, and the variable has no effect
 * while the key covers the running release.
 */

/** Environment switch: start a release the installed key does not cover as Community. */
export const RUN_AS_COMMUNITY_ENV = "RESTOW_RUN_AS_COMMUNITY";

export function runAsCommunityRequested(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = (env[RUN_AS_COMMUNITY_ENV] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** The update terms of an installed row (columns of 0.4.5; null on older rows). */
export function updateTermsOf(row: Partial<Pick<License, "series" | "updatesUntil">>): UpdateTerms {
  return { series: row.series ?? null, updatesUntil: row.updatesUntil ?? null };
}

/** Anything that can run a select: the pool or an open transaction. */
export type LicenseReader = Pick<Database, "select">;

type Environment = Readonly<Record<string, string | undefined>>;

/** The active installed license row, or null when the installation runs without a key. */
export async function loadInstalledLicense(db: LicenseReader): Promise<License | null> {
  const [row] = await db
    .select()
    .from(license)
    .where(eq(license.active, true))
    .orderBy(desc(license.createdAt))
    .limit(1);
  return row ?? null;
}

/** The terms in effect for an installed row (or none) and the environment. */
export function effectiveLicenseOf(
  installed: (Pick<License, "edition"> & Partial<Pick<License, "series" | "updatesUntil">>) | null,
  env: Environment = process.env,
): EffectiveLicense {
  if (
    installed &&
    installed.edition !== "community" &&
    runAsCommunityRequested(env) &&
    !updateEntitlement(updateTermsOf(installed), runningBuildOf(env)).entitled
  ) {
    return { edition: "community", source: "environment", runAsCommunity: true };
  }
  return resolveEffectiveLicense(installed, environmentEdition(env));
}

export async function loadEffectiveLicense(
  db: LicenseReader,
  env: Environment = process.env,
): Promise<EffectiveLicense> {
  return effectiveLicenseOf(await loadInstalledLicense(db), env);
}

/** The edition in effect right now. */
export async function currentEdition(
  db: LicenseReader,
  env: Environment = process.env,
): Promise<LicenseEdition> {
  return (await loadEffectiveLicense(db, env)).edition;
}

/** Whether the edition in effect includes `capability`. */
export async function installationHasCapability(
  db: LicenseReader,
  capability: Capability,
  env: Environment = process.env,
): Promise<boolean> {
  return hasCapability(await currentEdition(db, env), capability);
}
