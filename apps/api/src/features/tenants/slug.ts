/**
 * Slugs derived from a name, for tenants the api names itself: the operator's
 * own organisation, which the setup wizard and the dashboard create from its
 * name alone. The rules mirror `tenantSlugSchema` (./schemas.ts) and the
 * web's `slugify` (apps/web features/tenants/slug.ts): 2 to 63 characters,
 * lowercase letters and digits, words separated by single hyphens.
 */

const SLUG_MIN_LENGTH = 2;
const SLUG_MAX_LENGTH = 63;

/** The slug of a name that has no usable letter or digit at all. */
export const FALLBACK_SLUG = "organisation";

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
 * "Müller & Söhne GmbH" becomes "mueller-soehne-gmbh". Empty for a name
 * without a letter or digit of the Latin alphabet.
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

/**
 * The first free slug for `name`: its own slug, then `-2`, `-3`, ... `taken`
 * says whether a slug is in use (a tenant or a better-auth organization has it).
 * A name that yields no slug of its own gets {@link FALLBACK_SLUG}.
 */
export async function availableSlug(
  name: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const derived = slugify(name);
  const base = derived.length >= SLUG_MIN_LENGTH ? derived : FALLBACK_SLUG;
  if (!(await taken(base))) {
    return base;
  }
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const suffix = `-${attempt}`;
    // The base is cut so that the numbered slug still fits the limit.
    const candidate = `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!(await taken(candidate))) {
      return candidate;
    }
  }
  throw new Error(`no free slug found for "${base}"`);
}
