/**
 * Editions, and where the edition in effect comes from.
 *
 * The editions differ only in which capabilities they unlock
 * (./capabilities.ts: Business adds the GoBD archive layer, roles and SSO;
 * Service Provider adds tenant management and the provider functions).
 * Everything here lives under ee/: the core never learns which edition runs,
 * it asks the extension points the ee/ modules fill (ee/README.md).
 */

export const LICENSE_EDITIONS = ["community", "business", "service_provider"] as const;
export type LicenseEdition = (typeof LICENSE_EDITIONS)[number];

/** Editions unlocked by a signed license key. Community needs no key. */
export const KEYED_EDITIONS = ["business", "service_provider"] as const;
export type KeyedEdition = (typeof KEYED_EDITIONS)[number];

export function isLicenseEdition(value: unknown): value is LicenseEdition {
  return typeof value === "string" && (LICENSE_EDITIONS as readonly string[]).includes(value);
}

export function isKeyedEdition(value: unknown): value is KeyedEdition {
  return typeof value === "string" && (KEYED_EDITIONS as readonly string[]).includes(value);
}

/**
 * Where the edition in effect comes from: an installed, verified license key,
 * or the environment (Community, or the demo's `RESTOW_EDITION`).
 */
export type LicenseSource = "key" | "environment";

/** The terms of an installed license as persisted (a verified key's content). */
export interface InstalledLicenseTerms {
  edition: LicenseEdition;
}

export interface EffectiveLicense {
  edition: LicenseEdition;
  source: LicenseSource;
}

/** Environment variable naming the edition of the public demo (deploy/demo). */
export const DEMO_EDITION_ENV = "RESTOW_EDITION";
/** Demo mode switch of the core (apps/api config `demo.enabled`). */
export const DEMO_MODE_ENV = "RESTOW_DEMO";

/**
 * The edition that applies without a key: Community. `RESTOW_EDITION` is
 * honoured only in demo mode (`RESTOW_DEMO=true`), where the read-only public
 * demo shows the Service Provider functions without a key
 * (deploy/demo/README.md). Anywhere else the variable has no effect, so a
 * leftover value never unlocks anything.
 */
export function environmentEdition(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LicenseEdition {
  const demo = (env[DEMO_MODE_ENV] ?? "").trim().toLowerCase() === "true";
  if (!demo) {
    return "community";
  }
  const named = (env[DEMO_EDITION_ENV] ?? "").trim().toLowerCase();
  return isLicenseEdition(named) ? named : "community";
}

/** The license in effect: an installed key's terms win, otherwise the environment's edition. */
export function resolveEffectiveLicense(
  installed: InstalledLicenseTerms | null,
  fallback: LicenseEdition,
): EffectiveLicense {
  return installed
    ? { edition: installed.edition, source: "key" }
    : { edition: fallback, source: "environment" };
}
