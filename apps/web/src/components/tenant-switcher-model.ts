import type { SessionTenant } from "@/lib/session";

/**
 * What the tenant switcher decides without a browser: the order of the list,
 * what the search matches and what the second line of a tenant says. Kept
 * apart from the component (components/tenant-switcher.tsx) so it can be
 * tested as plain data.
 */

type SwitcherTenant = Pick<SessionTenant, "name" | "slug" | "kind" | "customerNumber">;

/** The operator's own organisation first, the rest in the order the session has them. */
export function orderTenants<T extends Pick<SessionTenant, "kind">>(tenants: readonly T[]): T[] {
  const own = tenants.filter((tenant) => tenant.kind === "internal");
  const others = tenants.filter((tenant) => tenant.kind !== "internal");
  return [...own, ...others];
}

/** Lower case, accents and diacritics removed: "muller" finds "Müller". */
export function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The text the switcher's search runs over: name, customer number and slug.
 * It is also the item's cmdk value, so it stays unique per tenant (slugs are).
 */
export function tenantSearchValue(tenant: SwitcherTenant): string {
  return [tenant.name, tenant.customerNumber, tenant.slug].filter(Boolean).join(" ");
}

/**
 * cmdk filter of the switcher: every word typed must occur somewhere in the
 * tenant's search text, in any order ("kd-10 mül" finds "Müller GmbH" with
 * the customer number KD-10234). Returns 1 for a match and 0 otherwise, so
 * the list keeps its order (own organisation first) instead of being ranked.
 */
export function matchTenantSearch(value: string, search: string): number {
  const words = foldForSearch(search).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return 1;
  }
  const haystack = foldForSearch(value);
  return words.every((word) => haystack.includes(word)) ? 1 : 0;
}

/** The second line under a tenant's name. */
export type TenantSubline =
  | { kind: "number"; number: string }
  | { kind: "internal" }
  | { kind: "organisation" }
  | { kind: "tenant" };

/**
 * What the second line says, so the trigger keeps one height whoever is
 * active: "Internal" for the own organisation, else the customer number, else
 * the word "Tenant". An installation with one organisation (no tenant
 * management) calls it "Organisation" and has no use for "Internal".
 */
export function tenantSublineOf(tenant: SwitcherTenant, organisationMode: boolean): TenantSubline {
  if (organisationMode) {
    return tenant.customerNumber
      ? { kind: "number", number: tenant.customerNumber }
      : { kind: "organisation" };
  }
  if (tenant.kind === "internal") {
    return { kind: "internal" };
  }
  return tenant.customerNumber
    ? { kind: "number", number: tenant.customerNumber }
    : { kind: "tenant" };
}
