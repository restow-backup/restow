import { type Database, type License, license } from "@restow/db";
import { desc, eq } from "drizzle-orm";
import { type Capability, hasCapability } from "./capabilities.js";
import {
  type EffectiveLicense,
  type LicenseEdition,
  environmentEdition,
  resolveEffectiveLicense,
} from "./editions.js";

/**
 * The installed license as the ee/ modules of every process read it: the
 * active row of the installation-level `license` table (no tenant, no Row
 * Level Security; read on the installation pool), else the environment's
 * edition (./editions.ts `environmentEdition`). Only verified terms are ever
 * stored (ee/api/src/license/service.ts), so the row is trusted as it is.
 * Read per call: installing or removing a key takes effect at once.
 */

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
  installed: Pick<License, "edition"> | null,
  env: Environment = process.env,
): EffectiveLicense {
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
