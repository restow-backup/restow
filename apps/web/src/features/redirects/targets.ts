/**
 * Old addresses of pages that moved when the menu took its final form
 * (0.1.0, maintainer decision 2026-10-01). Links in mails, notifications,
 * alerts, bookmarks and the documentation keep working: each old address
 * leads to the new one with its query intact, replacing the history entry so
 * Back does not bounce. Pure data and functions here, the routes in index.ts.
 *
 * Not redirected because they did not move: `/backup`, `/sources…`,
 * `/protected-objects`, `/schedules`, `/retention`, `/imports…` (the tenant
 * setup area shows them as tabs), `/restore/jobs/<id>`, `/settings`,
 * `/account`.
 */

export type SearchParams = Readonly<Record<string, unknown>>;

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

/** The run list ("Jobs") became History; `/jobs` itself now belongs to job definitions. */
export function jobsTarget(search: SearchParams): RedirectTarget {
  return { to: "/history", search: without(search, "type") };
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

/** Storage became Repositories. */
export function storageTarget(search: SearchParams): RedirectTarget {
  return { to: "/repositories", search: { ...search } };
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
 * Where an old address leads, or null for an address that did not move.
 * One function for all of them, so a table test covers every redirect.
 */
export function legacyTarget(pathname: string, search: SearchParams = {}): RedirectTarget | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/stats") {
    return statsTarget(search);
  }
  if (path === "/jobs") {
    return jobsTarget(search);
  }
  if (path === "/restore/jobs") {
    return restoreJobsTarget(search);
  }
  if (path === "/reports") {
    return reportsTarget(search);
  }
  if (path === "/storage") {
    return storageTarget(search);
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
  return null;
}
