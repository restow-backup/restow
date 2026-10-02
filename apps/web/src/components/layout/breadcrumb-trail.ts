import { ALL_TENANTS_NAV_ID, isNavItemPage } from "@/lib/navigation";
import { TENANT_SETTINGS_NAV_IDS } from "@/lib/tenant-nav";

/**
 * The breadcrumb trail of a shell page, as plain data: the scope the page
 * works in, the navigation group, the navigation entry (a link when the page
 * sits below it) and the title the page published, which names the entity on
 * a detail page ("Weekly mail backup"). Pages that publish no title end at
 * their navigation entry.
 *
 * The scope comes first and says on which level the page works: the
 * installation, the one organisation, the own organisation of the operator, a
 * tenant by name, or all tenants (lib/session.tsx has the tenants; the level
 * is chosen by {@link scopeKindOf}). It replaces the tenant switcher the top
 * bar used to carry; the switcher itself sits in the sidebar now.
 *
 * The group crumb (e.g. "Daily") is not a page of its own and never a link.
 * It opens a small menu instead that lists the entries of its group, the
 * same as the sidebar section does (components/layout/shell-breadcrumbs.tsx),
 * so the visitor can move sideways without reaching for the sidebar. Nothing
 * is said twice: where the group is named like the scope ("Installation"),
 * the scope crumb carries that menu itself ({@link scopeOpensGroup}); where the entry is named like the
 * scope ("All tenants"), the scope crumb is the entry.
 *
 * Pages of the tenant page read "<scope> > <group> > <entry> > <section>": the
 * entry crumb ("Tenant settings") leads to the page of the tenant, the section
 * is the title the page published, the current page.
 */

/** The level a page works on; decides the pill's icon and tint. */
export type ScopeKind = "installation" | "all" | "internal" | "tenant" | "organisation";

export interface Crumb {
  key: string;
  label: string;
  /** Link target; the group crumb and the current page have none. */
  to?: string;
  /** The page the visitor is on (`aria-current="page"`). */
  current?: boolean;
  /**
   * The group crumb: rendered as a menu of the group's entries. On the scope
   * crumb it names the group whose menu the pill opens.
   */
  group?: string;
  /** The scope crumb: rendered as a pill of this kind. */
  scope?: ScopeKind;
}

export interface TrailInput {
  pathname: string;
  /** The navigation entry the page belongs to, with its translated label. */
  entry: { id: string; path: string; label: string } | null;
  /** Translated label of the entry's group; null for pages outside the menu. */
  groupLabel: string | null;
  /** The group's id (for the group menu); omitted, the crumb is plain text. */
  groupId?: string | null;
  /** Title the page published through the page context. */
  pageTitle: string | null;
  /**
   * The level the page works on, translated; null where no level applies.
   * `opensGroup` says the pill also stands for the entry's group, so it opens
   * that group's menu and the group crumb is left out (see
   * {@link scopeOpensGroup}); a group named exactly like the scope does so too.
   */
  scope?: { kind: ScopeKind; label: string; opensGroup?: boolean } | null;
}

function normalize(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

export interface ScopeContext {
  /** Group of the page's menu entry; null for pages outside the menu (account security). */
  groupId: string | null;
  /** Id of the page's menu entry. */
  entryId: string | null;
  /** Kind of the active tenant; null while there is none. */
  tenantKind: "customer" | "internal" | null;
  /** The installation has one organisation and no tenant management. */
  organisationMode: boolean;
  /** The session works on "All tenants" (lib/tenant.ts `SessionScope`). */
  allTenants?: boolean;
  /**
   * The viewer may open the list of all tenants ("Manage tenants"): provider admins. A page
   * that resolves to that entry for somebody else (the page of a tenant that is not theirs)
   * belongs to their own level, never to "All tenants".
   */
  mayManageTenants?: boolean;
}

/**
 * The level a page works on, or null where none applies. Installation pages
 * (settings, team, audit log, license, resources) work on the installation,
 * the list of all tenants, and every page while the session works on "All
 * tenants", on all of them; everything else works on the active tenant, which an
 * installation with one organisation calls "Organisation".
 */
export function scopeKindOf(context: ScopeContext): ScopeKind | null {
  if (context.groupId === null) {
    return null;
  }
  if (context.groupId === "installation") {
    return "installation";
  }
  if (context.entryId === ALL_TENANTS_NAV_ID && context.mayManageTenants !== false) {
    return "all";
  }
  // A tenant's own page names its tenant, even in the moment before it leaves "All tenants".
  if (context.allTenants && !TENANT_SETTINGS_NAV_IDS.includes(context.entryId ?? "")) {
    return "all";
  }
  if (context.tenantKind === null) {
    return null;
  }
  if (context.organisationMode) {
    return "organisation";
  }
  return context.tenantKind === "internal" ? "internal" : "tenant";
}

/**
 * Whether the scope pill of `kind` already names the section `groupId`, so
 * that the pill opens the section's menu and a crumb of the section would say
 * the same twice: the installation is its section "Installation", and the one
 * organisation of an installation without tenant management is its section
 * "Organisation" ("Organisation: Contoso" > "Organisation" would be a stutter).
 */
export function scopeOpensGroup(kind: ScopeKind, groupId: string | null): boolean {
  return (
    (kind === "installation" && groupId === "installation") ||
    (kind === "organisation" && groupId === "tenants")
  );
}

export function buildBreadcrumbTrail({
  pathname,
  entry,
  groupLabel,
  groupId = null,
  pageTitle,
  scope = null,
}: TrailInput): Crumb[] {
  const title = pageTitle?.trim() || null;
  if (!entry) {
    return title ? [{ key: "page", label: title, current: true }] : [];
  }

  const trail: Crumb[] = [];
  const scopeCrumb: Crumb | null = scope
    ? { key: "scope", label: scope.label, scope: scope.kind }
    : null;

  if (scopeCrumb && entry.label === scope?.label) {
    // The scope is the entry ("All tenants"): one crumb says both.
    if (isNavItemPage(entry, pathname)) {
      return [{ ...scopeCrumb, current: true }];
    }
    trail.push({ ...scopeCrumb, to: entry.path });
    if (title && title !== entry.label) {
      trail.push({ key: "page", label: title, current: true });
    }
    return trail;
  }

  // A group the scope stands for ("Installation", the organisation's own section) is the scope crumb's menu.
  const groupIsScope = Boolean(
    scope && groupId && (scope.opensGroup || groupLabel === scope.label),
  );
  if (scopeCrumb) {
    trail.push(groupIsScope && groupId ? { ...scopeCrumb, group: groupId } : scopeCrumb);
  }

  // "Overview > Overview" says nothing twice: a group named like its entry is left out.
  if (groupLabel && !groupIsScope && groupLabel !== entry.label) {
    trail.push({ key: "group", label: groupLabel, ...(groupId ? { group: groupId } : {}) });
  }

  if (isNavItemPage(entry, pathname)) {
    trail.push({ key: `entry:${entry.id}`, label: entry.label, current: true });
    return trail;
  }

  trail.push({ key: `entry:${entry.id}`, label: entry.label, to: entry.path });
  if (title && title !== entry.label) {
    trail.push({ key: "page", label: title, current: true });
  }
  return trail;
}
