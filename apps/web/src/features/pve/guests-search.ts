import type { PveGuest, PveNode } from "./api.js";
import {
  GUEST_STATE_FILTERS,
  type GuestStateFilter,
  type GuestStatus,
  guestStatuses,
  matchesStateFilter,
  statusRank,
} from "./guest-status.js";

/**
 * The address of VMs & containers (`/virtualization?…`): the tab, the search, the filters,
 * the order and the page of the guests, and the guest whose detail panel is open. Defaults
 * stay out of the URL, so the plain address is the plain page and a link opens the same view.
 *
 * The overview API returns every guest of the tenant at once (it is shared by the job list,
 * the inventory and the file restore). This page filters, sorts and pages in memory, once per
 * change (memoised), and renders one page of rows only, so thousands of guests stay quick.
 */

export const PVE_TABS = ["guests", "jobs", "nodes"] as const;
export type PveTab = (typeof PVE_TABS)[number];

export const GUEST_SORTS = ["vmid", "name", "node", "lastBackup", "size", "state"] as const;
export type GuestSort = (typeof GUEST_SORTS)[number];

export const GUEST_PAGE_SIZES = [25, 50, 100, 250] as const;
export const DEFAULT_GUEST_PAGE_SIZE = 50;

/** "No job" in the job filter (`?job=none`). */
export const NO_JOB = "none";

export interface PveSearch {
  tab?: PveTab;
  q?: string;
  node?: string;
  kind?: "vm" | "ct";
  job?: string;
  state?: GuestStateFilter;
  sort?: GuestSort;
  desc?: true;
  page?: number;
  size?: number;
  /** The guest whose detail panel is open. */
  guest?: string;
}

function text(value: unknown, max = 200): string | undefined {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().slice(0, max);
  return trimmed === "" ? undefined : trimmed;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function positive(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** The page's search from the URL; anything unknown or malformed is left out. */
export function parsePveSearch(search: Record<string, unknown>): PveSearch {
  const tab = oneOf(PVE_TABS, search.tab);
  const size = positive(search.size);
  const page = positive(search.page);
  const result: PveSearch = {
    tab: tab === "guests" ? undefined : tab,
    q: text(search.q),
    node: text(search.node),
    kind: oneOf(["vm", "ct"] as const, search.kind),
    job: text(search.job),
    state: oneOf(GUEST_STATE_FILTERS, search.state),
    sort: oneOf(GUEST_SORTS, search.sort),
    desc: search.desc === true || search.desc === "true" ? true : undefined,
    page: page && page > 1 ? page : undefined,
    size:
      size &&
      (GUEST_PAGE_SIZES as readonly number[]).includes(size) &&
      size !== DEFAULT_GUEST_PAGE_SIZE
        ? size
        : undefined,
    guest: text(search.guest),
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  ) as PveSearch;
}

/** Whether a search narrows the guests (the page's "Reset filters"). */
export function hasGuestFilter(search: PveSearch): boolean {
  return Boolean(search.q || search.node || search.kind || search.job || search.state);
}

/** A guest with what the table derives from it once per refresh. */
export interface GuestRow {
  guest: PveGuest;
  node: PveNode | null;
  statuses: GuestStatus[];
}

/** The rows of the guests table: every guest with its node and its states. */
export function guestRows(guests: readonly PveGuest[], nodeOf: (g: PveGuest) => PveNode | null) {
  return guests.map((guest) => {
    const node = nodeOf(guest);
    return { guest, node, statuses: guestStatuses(guest, node) } satisfies GuestRow;
  });
}

/** Whether a row matches the search text: the ID (exactly or as a prefix) or the name. */
function matchesText(guest: PveGuest, query: string): boolean {
  const needle = query.toLowerCase();
  return String(guest.vmid).startsWith(needle) || (guest.name ?? "").toLowerCase().includes(needle);
}

export function filterGuests(rows: readonly GuestRow[], search: PveSearch): GuestRow[] {
  return rows.filter(({ guest, statuses }) => {
    if (search.q && !matchesText(guest, search.q)) return false;
    if (search.node && guest.node !== search.node) return false;
    if (search.kind && guest.kind !== search.kind) return false;
    if (search.job) {
      if (search.job === NO_JOB ? guest.jobId !== null : guest.jobId !== search.job) return false;
    }
    if (search.state && !matchesStateFilter(statuses, search.state)) return false;
    return true;
  });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(a: GuestRow, b: GuestRow, sort: GuestSort): number {
  switch (sort) {
    case "vmid":
      return a.guest.vmid - b.guest.vmid;
    case "name":
      return collator.compare(a.guest.name ?? "", b.guest.name ?? "");
    case "node":
      return collator.compare(a.guest.node ?? "", b.guest.node ?? "");
    case "lastBackup":
      // Never backed up sorts as the oldest.
      return (
        (a.guest.lastBackupAt ? Date.parse(a.guest.lastBackupAt) : 0) -
        (b.guest.lastBackupAt ? Date.parse(b.guest.lastBackupAt) : 0)
      );
    case "size":
      return (a.guest.backups?.last?.contains ?? -1) - (b.guest.backups?.last?.contains ?? -1);
    case "state":
      return statusRank(a.statuses[0] as GuestStatus) - statusRank(b.statuses[0] as GuestStatus);
  }
}

/** The rows in the order of the search (by ID when none); ties keep the ID order. */
export function sortGuests(rows: readonly GuestRow[], search: PveSearch): GuestRow[] {
  const sort = search.sort ?? "vmid";
  const direction = search.desc ? -1 : 1;
  return [...rows].sort((a, b) => direction * compare(a, b, sort) || a.guest.vmid - b.guest.vmid);
}
