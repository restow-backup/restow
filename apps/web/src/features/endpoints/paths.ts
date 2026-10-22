import type { LinkProps } from "@tanstack/react-router";

/**
 * Paths of the server and client backup section (Servers & endpoints).
 * Feature routes are registered at runtime, so the static route typing cannot
 * know them (same approach as the other features).
 *
 * Inventory lists every machine with an agent; the chips All, Servers and
 * Clients filter it (`?kind=server|client`). The page of one machine sits
 * below it (`/inventory/<id>`), so the sidebar keeps Inventory highlighted and
 * the breadcrumbs read "Servers & endpoints > Inventory > <name>". The lists
 * of 0.1.0 before the final menu (`/endpoints/{agents,servers,clients}`) and
 * their machine pages lead here (features/redirects).
 *
 * Internally the list still speaks of three "areas": `agents` is the whole
 * inventory, `servers` and `clients` its filtered views.
 */
export const INVENTORY_PATH = "/inventory";
export const FILE_RESTORE_PATH = "/file-restore";

/** Servers and clients are administered by tenant admins and provider admins. */
export const ENDPOINT_ROLES = ["provider_admin", "tenant_admin"] as const;

/**
 * File restore is also for restore operators: they browse, download and restore the files of
 * machines and Proxmox VE guests, and change nothing else (apps/api middleware/rbac.ts).
 */
export const FILE_RESTORE_ROLES = ["provider_admin", "tenant_admin", "tenant_restore"] as const;

export const ENDPOINT_AREAS = ["agents", "servers", "clients"] as const;
export type EndpointArea = (typeof ENDPOINT_AREAS)[number];

export type EndpointProfile = "server" | "client";

/** The inventory filter in the URL; absent shows every machine. */
export interface InventorySearch {
  kind?: EndpointProfile;
  /** The machine whose detail panel is open (0.4.5). */
  machine?: string;
}

/** An id as the address may carry it (a UUID; anything else is ignored). */
const MACHINE_ID = /^[0-9a-f-]{8,64}$/i;

/** Read `?kind=` (anything but `server` or `client` shows every machine) and `?machine=`. */
export function parseInventorySearch(search: Record<string, unknown>): InventorySearch {
  const result: InventorySearch = {};
  if (search.kind === "server" || search.kind === "client") {
    result.kind = search.kind;
  }
  if (typeof search.machine === "string" && MACHINE_ID.test(search.machine)) {
    result.machine = search.machine;
  }
  return result;
}

/** The list view of a filter. */
export function areaOfKind(kind: EndpointProfile | undefined): EndpointArea {
  return kind === undefined ? "agents" : areaOfProfile(kind);
}

/** The filter of a list view. */
export function inventorySearch(area: EndpointArea): InventorySearch {
  const kind = profileOfArea(area);
  return kind ? { kind } : {};
}

/** The route pattern of a machine's page. */
export const ENDPOINT_DETAIL_PATTERN = `${INVENTORY_PATH}/$endpointId`;

export function inventoryTo(): LinkProps["to"] {
  return INVENTORY_PATH as LinkProps["to"];
}

export function endpointDetailTo(endpointId: string): LinkProps["to"] {
  return `${INVENTORY_PATH}/${encodeURIComponent(endpointId)}` as LinkProps["to"];
}

/** The list a machine of this profile belongs to. */
export function areaOfProfile(profile: EndpointProfile): EndpointArea {
  return profile === "server" ? "servers" : "clients";
}

/** The profile a list shows; the whole inventory shows every profile. */
export function profileOfArea(area: EndpointArea): EndpointProfile | undefined {
  if (area === "servers") {
    return "server";
  }
  if (area === "clients") {
    return "client";
  }
  return undefined;
}

export const ENDPOINT_TABS = ["overview", "snapshots", "settings"] as const;
export type EndpointTab = (typeof ENDPOINT_TABS)[number];

/** The tab named in the URL (`?tab=snapshots`); anything else opens the overview. */
export function parseTab(value: unknown): EndpointTab {
  return ENDPOINT_TABS.includes(value as EndpointTab) ? (value as EndpointTab) : "overview";
}

/** Search of a machine's page: the overview is the default and stays out of the URL. */
export function parseDetailSearch(search: Record<string, unknown>): { tab?: EndpointTab } {
  const tab = parseTab(search.tab);
  return tab === "overview" ? {} : { tab };
}

/**
 * Search of the file restore page: the chosen machine (`?machine=`) or Proxmox
 * VE container (`?container=`, the guest id, #62). `?mailbox=` is what earlier
 * versions linked a mailbox with, and the route sends such a link on to the
 * restore explorer.
 */
export interface FileRestoreSearch {
  machine?: string;
  container?: string;
  mailbox?: string;
}

function searchId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

export function parseFileRestoreSearch(search: Record<string, unknown>): FileRestoreSearch {
  const machine = searchId(search.machine);
  if (machine) {
    return { machine };
  }
  const container = searchId(search.container);
  if (container) {
    return { container };
  }
  const mailbox = searchId(search.mailbox);
  return mailbox ? { mailbox } : {};
}

/** A link target as `<Link {...target}>` or `navigate(target)` take it. */
export interface FileRestoreTarget {
  to: LinkProps["to"];
  search: FileRestoreSearch;
}

/**
 * File restore with this machine chosen: its restore points and the file
 * browser. The machine table's "Restore files" leads here
 * (`<Link {...fileRestoreTo(id)}>`).
 */
export function fileRestoreTo(machineId: string): FileRestoreTarget {
  return { to: FILE_RESTORE_PATH as LinkProps["to"], search: { machine: machineId } };
}

/** File restore with this Proxmox VE container chosen (#62): its restore points and files. */
export function fileRestoreContainerTo(guestId: string): FileRestoreTarget {
  return { to: FILE_RESTORE_PATH as LinkProps["to"], search: { container: guestId } };
}
