/**
 * Tenant slugs: the short, URL-safe name of a tenant (and of its better-auth
 * organization). The rules mirror the API (`tenantSlugSchema` in
 * apps/api/src/features/tenants/schemas.ts): 2 to 63 characters, lowercase
 * letters and digits, words separated by single hyphens.
 */

export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 63;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** German letters that have a conventional ASCII spelling (not just a stripped accent). */
const TRANSLITERATIONS: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  æ: "ae",
  ø: "oe",
  å: "aa",
  œ: "oe",
};

/**
 * Derive a slug from a tenant name: "Müller & Söhne GmbH" -> "mueller-soehne-gmbh".
 * The result may be shorter than the minimum (or empty) for names without
 * any usable letters; validation reports that.
 */
export function slugify(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[äöüßæøåœ]/g, (letter) => TRANSLITERATIONS[letter] ?? letter)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  const slug = ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
  // Cutting at the length limit may leave a trailing hyphen.
  return slug.replace(/-+$/g, "");
}

export type SlugProblem = "slugTooShort" | "slugTooLong" | "slugFormat";

/** Why a slug is not acceptable, or null when it is. */
export function slugProblem(slug: string): SlugProblem | null {
  if (slug.length < SLUG_MIN_LENGTH) {
    return "slugTooShort";
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    return "slugTooLong";
  }
  return SLUG_PATTERN.test(slug) ? null : "slugFormat";
}
