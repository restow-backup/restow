import { isNavItemPage } from "@/lib/navigation";

/**
 * The breadcrumb trail of a shell page, as plain data: the navigation group,
 * the navigation entry (a link when the page sits below it) and the title the
 * page published, which names the entity on a detail page ("Weekly mail
 * backup"). Pages that publish no title end at their navigation entry.
 *
 * The group crumb (e.g. "Admin") is not a page of its own and never a link.
 * It opens a small menu instead that lists the entries of its group, the
 * same as the sidebar section does (components/layout/shell-breadcrumbs.tsx),
 * so the visitor can move sideways without reaching for the sidebar.
 *
 * Pages of the tenant setup area read "Tenants › <tenant or Setup> › <tab>":
 * the middle crumb leads to the area's first tab, the tab crumb is the
 * current page on the tab itself and a link on a page below it.
 */

export interface Crumb {
  key: string;
  label: string;
  /** Link target; the group crumb and the current page have none. */
  to?: string;
  /** The page the visitor is on (`aria-current="page"`). */
  current?: boolean;
  /** The group crumb: rendered as a menu of the group's entries. */
  group?: string;
}

export interface TrailInput {
  pathname: string;
  /** The navigation entry the page belongs to, with its translated label. */
  entry: { id: string; path: string; label: string } | null;
  /** Translated label of the entry's group; null for pages outside the menu. */
  groupLabel: string | null;
  /** The group's id (for the group menu); omitted, the crumb is plain text. */
  groupId?: string | null;
  /**
   * The tab of the tenant setup area the page belongs to, translated. With
   * it, `entry` is the area itself (its label the tenant name or "Setup",
   * its path the area's first tab).
   */
  setupTab?: { id: string; path: string; label: string } | null;
  /** Title the page published through the page context. */
  pageTitle: string | null;
}

function normalize(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

export function buildBreadcrumbTrail({
  pathname,
  entry,
  groupLabel,
  groupId = null,
  setupTab = null,
  pageTitle,
}: TrailInput): Crumb[] {
  const title = pageTitle?.trim() || null;
  if (!entry) {
    return title ? [{ key: "page", label: title, current: true }] : [];
  }

  // "Overview > Overview" says nothing twice: a group named like its entry is left out.
  const trail: Crumb[] =
    groupLabel && groupLabel !== entry.label
      ? [{ key: "group", label: groupLabel, ...(groupId ? { group: groupId } : {}) }]
      : [];

  if (setupTab) {
    trail.push({ key: `entry:${entry.id}`, label: entry.label, to: entry.path });
    if (normalize(pathname) === normalize(setupTab.path)) {
      trail.push({ key: `tab:${setupTab.id}`, label: setupTab.label, current: true });
      return trail;
    }
    trail.push({ key: `tab:${setupTab.id}`, label: setupTab.label, to: setupTab.path });
    if (title && title !== setupTab.label) {
      trail.push({ key: "page", label: title, current: true });
    }
    return trail;
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
