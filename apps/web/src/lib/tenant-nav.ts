import type { NavItem } from "@/lib/navigation";

/**
 * The menu entry that opens the tenant page of the active tenant, in two
 * wordings that stand for each other: "Tenant settings" where the installation
 * manages tenants (`tenants.additional`) and "Settings" of the one organisation
 * where it does not (features/tenant-page/index.ts has the entries). Its
 * address holds the placeholder {@link ACTIVE_TENANT_PLACEHOLDER}, because the
 * entry exists once and leads to whichever tenant is active; {@link withActiveTenant}
 * puts the tenant in (lib/use-nav-items.ts), and the shell highlights the
 * entry on every section of that tenant's page.
 */

/** Id of the entry where the installation manages tenants: "Tenant settings". */
export const TENANT_SETTINGS_NAV_ID = "tenant-settings";

/** Id of the entry in a one-organisation installation: "Settings". */
export const ORGANISATION_SETTINGS_NAV_ID = "organisation-settings";

/** The two entries stand for each other (exactly one is offered); either one is the tenant page's entry. */
export const TENANT_SETTINGS_NAV_IDS: readonly string[] = [
  TENANT_SETTINGS_NAV_ID,
  ORGANISATION_SETTINGS_NAV_ID,
];

/** Stands for the active tenant's id in the entry's address. */
export const ACTIVE_TENANT_PLACEHOLDER = "$activeTenant";

/** The address of the entry: the overview of the active tenant. */
export const TENANT_SETTINGS_PATH = `/tenants/${ACTIVE_TENANT_PLACEHOLDER}/overview`;

/** Every page of the tenant page belongs to the entry. */
export const TENANT_PAGE_MATCH = `/tenants/${ACTIVE_TENANT_PLACEHOLDER}`;

/**
 * Id of the entry "Repositories" next to the settings entry: a shortcut into
 * the section of the tenant page that lists the active tenant's repositories
 * (features/storage). On that section it is the entry the shell highlights
 * (components/layout/shell-entry.ts); every other section belongs to the
 * settings entry.
 */
export const REPOSITORIES_NAV_ID = "repositories";

/** The address of the "Repositories" entry: the storage section of the active tenant. */
export const REPOSITORIES_PATH = `/tenants/${ACTIVE_TENANT_PLACEHOLDER}/storage`;

/**
 * The items with the active tenant in the settings entry's address. Without an
 * active tenant (the profile is still loading, or the person belongs to none)
 * the entry leads to the list of tenants, which a provider admin can open and
 * anybody else is shown as not theirs, instead of to an address with a hole.
 */
export function withActiveTenant(
  items: readonly NavItem[],
  activeTenantId: string | null,
): readonly NavItem[] {
  const fill = (path: string) =>
    path.replace(
      ACTIVE_TENANT_PLACEHOLDER,
      activeTenantId ? encodeURIComponent(activeTenantId) : "",
    );
  return items.map((item) => {
    if (!item.path.includes(ACTIVE_TENANT_PLACEHOLDER)) {
      return item;
    }
    if (!activeTenantId) {
      return { ...item, path: "/tenants", matches: [] };
    }
    return {
      ...item,
      path: fill(item.path),
      ...(item.matches ? { matches: item.matches.map(fill) } : {}),
    };
  });
}
