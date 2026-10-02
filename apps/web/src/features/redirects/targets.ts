/**
 * Old addresses of pages that moved when the menu took its final form
 * (0.1.0, maintainer decision 2026-10-01). Links in mails, notifications,
 * alerts, bookmarks and the documentation keep working: each old address
 * leads to the new one with its query intact, replacing the history entry so
 * Back does not bounce. Pure data and functions here, the routes in index.ts.
 *
 * Release 0.2.0 moved the settings page to the installation page
 * (`/installation/<section>`): `/settings` and every `/settings?section=…`
 * lead to the section that took over (the provider API keys, which used to sit
 * on the Integrations page, are answered with that page's address below).
 *
 * Release 0.2.0 also moved everything that belongs to one tenant onto the tenant
 * page (`/tenants/<id>/<section>`, features/tenant-page): `/sources…`,
 * `/protected-objects`, `/schedules`, `/retention`, `/imports…`,
 * `/members`, `/repositories` and `/integrations…` lead to the section of the
 * tenant that is active (or, where the address names one, to that tenant: the
 * admin-consent callback appends `tenant=<id>`); `?tab=provider-keys` of the
 * integrations leads to the installation's provider API where it exists.
 * `/backup` is not among them since the job definitions (release 0.2.0): the
 * per-object backup it showed is what Mail & SaaS Jobs run, so it leads to
 * `/jobs?type=mail`.
 *
 * Not redirected because they did not move: `/restore/jobs/<id>`, `/account`.
 */

import { providerKeysDestination } from "@/features/integrations/paths";
import { tenantPagePath } from "@/lib/tenant-paths";

export type SearchParams = Readonly<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RedirectTarget {
  /** Absolute app path. */
  to: string;
  search: Record<string, unknown>;
}

function without(search: SearchParams, ...keys: string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(search)) {
    if (!keys.includes(key)) {
      rest[key] = value;
    }
  }
  return rest;
}

/** Statistics became the second tab of Overview; period, range and scope stay. */
export function statsTarget(search: SearchParams): RedirectTarget {
  return { to: "/", search: { ...without(search, "view"), view: "statistics" } };
}

/** The tab of History an old run list's `queue` filter leads to (the queues of the jobs API). */
const QUEUE_TAB: Readonly<Record<string, string>> = {
  backup: "backup",
  restore: "restore",
  verify: "restore_check",
  export: "export",
  import: "import",
  archive: "maintenance",
  directory: "maintenance",
  retention: "maintenance",
  scrub: "maintenance",
  storage_migration: "maintenance",
};

/**
 * The run list ("Jobs") became History; `/jobs` itself now belongs to job definitions. The old
 * `?queue=` filter becomes the tab of the same kind of run (`?type=`); the other parameters stay.
 */
export function jobsTarget(search: SearchParams): RedirectTarget {
  const rest = without(search, "type", "queue");
  const tab = typeof search.queue === "string" ? QUEUE_TAB[search.queue] : undefined;
  return { to: "/history", search: tab ? { ...rest, type: tab } : rest };
}

/** The per-object backup page became the mail jobs (the job definitions, 0.2.0). */
export function backupTarget(): RedirectTarget {
  return { to: "/jobs", search: { type: "mail" } };
}

/** A run's page. */
export function runTarget(jobId: string, search: SearchParams): RedirectTarget {
  return { to: `/history/${encodeURIComponent(jobId)}`, search: { ...search } };
}

/** Restore jobs became the tab "Recent restores" of the restore explorer. */
export function restoreJobsTarget(search: SearchParams): RedirectTarget {
  return { to: "/restore", search: { ...without(search, "tab"), tab: "recent" } };
}

/** "Alerts & reports" became Alerts. */
export function reportsTarget(search: SearchParams): RedirectTarget {
  return { to: "/alerts", search: { ...search } };
}

/** Storage became Repositories, and Repositories the Storage section of the tenant page. */
export function storageTarget(search: SearchParams, tenantId: string | null): RedirectTarget {
  return tenantTarget(tenantId, "storage", [], search);
}

/** Where a person without any tenant goes instead of a tenant page. */
const NO_TENANT_TARGET: RedirectTarget = { to: "/", search: {} };

/**
 * A section of a tenant's page, with the search the old address carried. `tenant`
 * (the admin-consent callback names the Restow tenant its link was made for)
 * is consumed here and does not travel on. Without a tenant to go to, the start page.
 */
export function tenantTarget(
  tenantId: string | null,
  section: string,
  rest: readonly string[],
  search: SearchParams,
  extra: Record<string, unknown> = {},
): RedirectTarget {
  const named =
    typeof search.tenant === "string" && UUID.test(search.tenant) ? search.tenant : null;
  const id = named ?? tenantId;
  if (!id) {
    return NO_TENANT_TARGET;
  }
  const merged = { ...without(search, "tenant"), ...extra };
  // A parameter set to undefined is a parameter dropped.
  const kept = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  );
  return { to: tenantPagePath(id, section, ...rest), search: kept };
}

/**
 * A section of the installation page as far as the redirects need it: its id
 * and the old settings section an extension says now leads to it.
 */
export interface InstallationSectionRef {
  readonly id: string;
  readonly legacySettingsSection?: string;
}

/** Where the tabs of the old settings page went. The danger zone held one action, which moved to the mail card. */
const SETTINGS_SECTION_TARGET: Readonly<Record<string, string>> = {
  general: "server",
  mail: "mail",
  microsoft365: "microsoft-app",
  updates: "updates",
  about: "about",
  danger: "mail",
};

/**
 * The settings page became the installation page. An old tab leads to the
 * section that took over its content; a section an extension claims for an
 * old tab wins over the core's own (the license left About for a section of
 * its own, so the old license link leads there where it exists). The opaque
 * `requires` marker of a link into About travels along. Unknown or missing
 * tabs lead to the first section.
 */
export function settingsTarget(
  search: SearchParams,
  sections: readonly InstallationSectionRef[] = [],
): RedirectTarget {
  const legacy = typeof search.section === "string" ? search.section : "general";
  const claimed = sections.find((section) => section.legacySettingsSection === legacy);
  const id = claimed?.id ?? SETTINGS_SECTION_TARGET[legacy] ?? "server";
  const requires =
    legacy === "about" && typeof search.requires === "string" ? { requires: search.requires } : {};
  return { to: `/installation/${id}`, search: requires };
}

export const LEGACY_ENDPOINT_AREAS = ["agents", "servers", "clients"] as const;
export type LegacyEndpointArea = (typeof LEGACY_ENDPOINT_AREAS)[number];

const KIND_OF_AREA: Readonly<Record<LegacyEndpointArea, string | undefined>> = {
  agents: undefined,
  servers: "server",
  clients: "client",
};

/** The three machine lists became one Inventory with filter chips. */
export function endpointListTarget(area: LegacyEndpointArea, search: SearchParams): RedirectTarget {
  const kind = KIND_OF_AREA[area];
  const rest = without(search, "kind");
  return { to: "/inventory", search: kind ? { ...rest, kind } : rest };
}

/** A machine's page moved below the inventory; its tab (`?tab=`) stays. */
export function endpointDetailTarget(endpointId: string, search: SearchParams): RedirectTarget {
  return { to: `/inventory/${encodeURIComponent(endpointId)}`, search: { ...search } };
}

/**
 * The old addresses of the pages that became sections of the tenant page
 * (0.2.0). `tenantId` is the tenant that is active in the browser; null when
 * there is none, which sends the visitor to the start page.
 */
function tenantPageTarget(
  path: string,
  search: SearchParams,
  tenantId: string | null,
  sections: readonly InstallationSectionRef[],
): RedirectTarget | null {
  const to = (section: string, rest: readonly string[] = [], extra: Record<string, unknown> = {}) =>
    tenantTarget(tenantId, section, rest, search, extra);
  switch (path) {
    case "/sources":
      return to("connections");
    case "/sources/import":
      return to("connections", ["imports", "new"]);
    case "/protected-objects":
      return to("protection");
    case "/schedules":
      return to("jobs");
    case "/retention":
      return to("retention");
    case "/imports":
      return to("connections", [], { tab: "imports" });
    case "/members":
      return to("members");
    case "/repositories":
      return to("storage");
    case "/integrations": {
      // The provider keys left this page for Installation, Provider API (0.2.0).
      const moved = providerKeysDestination(
        { tab: typeof search.tab === "string" ? search.tab : undefined },
        sections.map((section) => section.id),
      );
      if (moved) {
        return { to: moved, search: {} };
      }
      return to("integrations", [], search.tab === "provider-keys" ? { tab: undefined } : {});
    }
  }
  const source = /^\/sources\/([^/]+)$/.exec(path);
  if (source?.[1]) {
    return to("connections", ["sources", decodeURIComponent(source[1])]);
  }
  const imported = /^\/imports\/([^/]+)$/.exec(path);
  if (imported?.[1]) {
    return to("connections", ["imports", decodeURIComponent(imported[1])]);
  }
  const webhook = /^\/integrations\/webhooks\/([^/]+)$/.exec(path);
  if (webhook?.[1]) {
    return to("integrations", ["webhooks", decodeURIComponent(webhook[1])]);
  }
  return null;
}

/**
 * Where an old address leads, or null for an address that did not move.
 * One function for all of them, so a table test covers every redirect.
 * `tenantId` is the tenant that is active in the browser, for the pages that
 * became sections of the tenant page.
 */
export function legacyTarget(
  pathname: string,
  search: SearchParams = {},
  sections: readonly InstallationSectionRef[] = [],
  tenantId: string | null = null,
): RedirectTarget | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/settings") {
    return settingsTarget(search, sections);
  }
  if (path === "/stats") {
    return statsTarget(search);
  }
  if (path === "/jobs") {
    return jobsTarget(search);
  }
  if (path === "/backup") {
    return backupTarget();
  }
  if (path === "/restore/jobs") {
    return restoreJobsTarget(search);
  }
  if (path === "/reports") {
    return reportsTarget(search);
  }
  if (path === "/storage") {
    return storageTarget(search, tenantId);
  }
  const run = /^\/jobs\/([^/]+)$/.exec(path);
  if (run?.[1]) {
    return runTarget(decodeURIComponent(run[1]), search);
  }
  const list = /^\/endpoints\/(agents|servers|clients)$/.exec(path);
  if (list?.[1]) {
    return endpointListTarget(list[1] as LegacyEndpointArea, search);
  }
  const detail = /^\/endpoints\/[^/]+\/([^/]+)$/.exec(path);
  if (detail?.[1]) {
    return endpointDetailTarget(decodeURIComponent(detail[1]), search);
  }
  return tenantPageTarget(path, search, tenantId, sections);
}
