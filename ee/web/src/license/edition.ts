import type { GatedFeature } from "@/lib/api";
import { useSession } from "@/lib/session";

/**
 * The editions, read from what ee/api adds to the profile: `/api/v1/me`
 * `extensions.edition` (the core passes the record on unread, lib/session.tsx
 * `extensions`). Every Business and Service Provider module of the web asks
 * here instead of the core, which knows nothing about editions.
 */

/** Editions from smallest to largest; a later edition includes the earlier ones. */
export const EDITIONS = ["community", "business", "service_provider"] as const;

export type Edition = (typeof EDITIONS)[number];

/** An edition a key unlocks (everything above Community). */
export type LicensedEdition = Exclude<Edition, "community">;

/** The field of `/api/v1/me` `extensions` that carries the edition. */
export const EDITION_FIELD = "edition";

export function isEdition(value: unknown): value is Edition {
  return typeof value === "string" && (EDITIONS as readonly string[]).includes(value);
}

/**
 * The edition among the profile's extension fields; null while the profile
 * loads (`extensions` null) or when the server sent no valid edition.
 */
export function readEdition(
  extensions: Readonly<Record<string, unknown>> | null | undefined,
): Edition | null {
  const value = extensions?.[EDITION_FIELD];
  return isEdition(value) ? value : null;
}

/**
 * Whether an installation of `edition` includes what needs `minimum`. An
 * unknown edition (null) includes nothing, so nothing appears that might
 * then vanish.
 */
export function editionAllows(edition: Edition | null, minimum: Edition): boolean {
  if (edition === null) {
    return false;
  }
  return EDITIONS.indexOf(edition) >= EDITIONS.indexOf(minimum);
}

/** The edition of the signed-in session (null until the profile loaded). */
export function useEdition(): Edition | null {
  return readEdition(useSession().extensions);
}

/** Which edition unlocks each gated core feature (packages/core capabilities). */
const FEATURE_EDITION: Readonly<Record<GatedFeature, LicensedEdition>> = {
  "tenants.additional": "service_provider",
  "apiKeys.provider": "service_provider",
  "stats.allTenants": "service_provider",
  "dashboard.allTenants": "service_provider",
  "reports.timed": "business",
};

/**
 * The edition a `?requires=` marker of Settings, About asks for: an edition
 * named directly (the menu locks of ee/web set that), or the edition that
 * unlocks a gated core feature. Null for anything else.
 */
export function requiredEditionOf(requires: string | null | undefined): LicensedEdition | null {
  if (requires === "business" || requires === "service_provider") {
    return requires;
  }
  return requires && Object.hasOwn(FEATURE_EDITION, requires)
    ? FEATURE_EDITION[requires as GatedFeature]
    : null;
}
