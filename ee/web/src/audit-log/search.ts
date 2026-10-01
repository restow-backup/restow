import { type AuditQuery, INSTALLATION_CHAIN } from "./api";

/**
 * URL state of the audit page: the filters plus the entry open in the detail
 * drawer, so every view can be linked, survives a reload and works with the
 * back button. Unknown or invalid values are dropped, never sent to the API.
 */

export const AUDIT_PATH = "/audit";

export interface AuditSearch {
  /** Provider admins: a tenant id or `installation`; omitted = everything. */
  tenant?: string;
  /** Exact action code or dotted prefix (`restore`, `restore.requested`). */
  action?: string;
  actor?: string;
  target?: string;
  /** First calendar day to include (`YYYY-MM-DD`, the viewer's local day). */
  from?: string;
  /** Last calendar day to include. */
  to?: string;
  /** Id of the entry shown in the drawer. */
  entry?: string;
}

/** The keys that filter the list (everything but the open entry). */
export const FILTER_KEYS = ["tenant", "action", "actor", "target", "from", "to"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A real calendar day in `YYYY-MM-DD` form, else undefined. */
export function calendarDay(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = DAY.exec(value);
  if (!match) {
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  const valid =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return valid ? value : undefined;
}

/** Validate raw search params (the route's `validateSearch`). */
export function parseAuditSearch(raw: Record<string, unknown>): AuditSearch {
  const search: AuditSearch = {};
  const tenant = text(raw.tenant, 64);
  if (tenant && (tenant === INSTALLATION_CHAIN || UUID.test(tenant))) {
    search.tenant = tenant;
  }
  const action = text(raw.action, 200);
  if (action && ACTION.test(action)) {
    search.action = action;
  }
  const actor = text(raw.actor, 200);
  if (actor) {
    search.actor = actor;
  }
  const target = text(raw.target, 500);
  if (target) {
    search.target = target;
  }
  let from = calendarDay(raw.from);
  let to = calendarDay(raw.to);
  if (from && to && from > to) {
    [from, to] = [to, from];
  }
  if (from) {
    search.from = from;
  }
  if (to) {
    search.to = to;
  }
  const entry = text(raw.entry, 64);
  if (entry && UUID.test(entry)) {
    search.entry = entry;
  }
  return search;
}

/** Apply a change; `undefined` removes a key. Changing a filter keeps the drawer closed. */
export function nextAuditSearch(current: AuditSearch, change: Partial<AuditSearch>): AuditSearch {
  const merged: Record<string, string | undefined> = { ...current, ...change };
  if (FILTER_KEYS.some((key) => key in change) && !("entry" in change)) {
    merged.entry = undefined;
  }
  return parseAuditSearch(merged);
}

export function hasFilters(search: AuditSearch, includeTenant: boolean): boolean {
  return FILTER_KEYS.some(
    (key) => (includeTenant || key !== "tenant") && search[key] !== undefined,
  );
}

/** Local midnight starting `day` plus `offsetDays`, as an instant. */
export function localDayStart(day: string, offsetDays = 0): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date + offsetDays);
}

/**
 * The API query for the URL state. Calendar days are the viewer's local days:
 * `from` starts at its local midnight, `to` includes the whole day (the API
 * bound is exclusive). The tenant filter applies to provider admins only.
 */
export function toAuditQuery(search: AuditSearch, isProviderAdmin: boolean): AuditQuery {
  const query: AuditQuery = {};
  if (isProviderAdmin && search.tenant) {
    query.tenant = search.tenant;
  }
  if (search.action) {
    query.action = search.action;
  }
  if (search.actor) {
    query.actor = search.actor;
  }
  if (search.target) {
    query.target = search.target;
  }
  if (search.from) {
    query.from = localDayStart(search.from).toISOString();
  }
  if (search.to) {
    query.to = localDayStart(search.to, 1).toISOString();
  }
  return query;
}
