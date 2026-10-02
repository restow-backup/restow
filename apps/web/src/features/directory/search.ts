import type { LinkProps } from "@tanstack/react-router";

import { activeTenantPagePath, activeTenantPageTo } from "@/lib/tenant-paths";

import type { ObjectKind, ObjectSort, ObjectStatusFilter, ObjectsQuery } from "./types";

/**
 * URL state of the protected-objects page: the tab plus the object filters,
 * sort and page, so every view can be linked and survives a reload.
 * Unknown or invalid values are dropped, never passed to the API.
 */

/**
 * Where the protected objects live: the Protection section of the active
 * tenant's page (features/tenant-page). The old address `/protected-objects`
 * leads there (features/redirects).
 */
export function directoryPath(): string {
  return activeTenantPagePath("protection");
}

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export type DirectoryTab = "objects" | "sources";

export interface DirectorySearch {
  tab?: DirectoryTab;
  q?: string;
  kind?: ObjectKind;
  status?: ObjectStatusFilter;
  source?: string;
  /** Sign-in disabled member accounts with a mailbox (shared, resource, blocked). */
  shared?: boolean;
  page?: number;
  size?: number;
  sort?: ObjectSort;
  order?: "asc" | "desc";
}

const KINDS: readonly ObjectKind[] = ["mailbox", "onedrive", "imap"];
const STATUSES: readonly ObjectStatusFilter[] = ["active", "excluded", "orphaned", "not_selected"];
const SORTS: readonly ObjectSort[] = ["name", "kind", "status", "createdAt", "updatedAt"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** Validate raw search params (the route's `validateSearch`). */
export function parseDirectorySearch(raw: Record<string, unknown>): DirectorySearch {
  const search: DirectorySearch = {};
  const tab = oneOf(raw.tab, ["objects", "sources"] as const);
  if (tab === "sources") {
    search.tab = tab;
  }
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, 200) : "";
  if (q) {
    search.q = q;
  }
  search.kind = oneOf(raw.kind, KINDS);
  search.status = oneOf(raw.status, STATUSES);
  if (typeof raw.source === "string" && UUID.test(raw.source)) {
    search.source = raw.source;
  }
  if (raw.shared === "true" || raw.shared === "false") {
    search.shared = raw.shared === "true";
  }
  const page = positiveInt(raw.page);
  if (page && page > 1) {
    search.page = page;
  }
  const size = positiveInt(raw.size);
  if (size && size !== DEFAULT_PAGE_SIZE && (PAGE_SIZES as readonly number[]).includes(size)) {
    search.size = size;
  }
  const sort = oneOf(raw.sort, SORTS);
  if (sort && sort !== "name") {
    search.sort = sort;
  }
  if (raw.order === "desc") {
    search.order = "desc";
  }
  for (const key of Object.keys(search) as (keyof DirectorySearch)[]) {
    if (search[key] === undefined) {
      delete search[key];
    }
  }
  return search;
}

/** The API query for the current URL state. */
export function toObjectsQuery(search: DirectorySearch): ObjectsQuery {
  return {
    search: search.q,
    kind: search.kind,
    status: search.status,
    sourceId: search.source,
    sharedOrBlocked: search.shared,
    page: search.page ?? 1,
    pageSize: search.size ?? DEFAULT_PAGE_SIZE,
    sort: search.sort ?? "name",
    order: search.order ?? "asc",
  };
}

/** Apply a change; any filter change returns to the first page. */
export function nextSearch(
  current: DirectorySearch,
  change: Partial<DirectorySearch>,
): DirectorySearch {
  const touchesFilter = (
    ["q", "kind", "status", "source", "shared", "size", "sort", "order"] as const
  ).some((key) => key in change);
  const merged: Record<string, unknown> = { ...current, ...change };
  if (touchesFilter && !("page" in change)) {
    merged.page = undefined;
  }
  return parseDirectorySearch(merged);
}

export function hasObjectFilters(search: DirectorySearch): boolean {
  return Boolean(
    search.q || search.kind || search.status || search.source || search.shared !== undefined,
  );
}

/** Feature routes are registered at runtime; the static route typing cannot know them. */
export function directoryTo(): LinkProps["to"] {
  return activeTenantPageTo("protection");
}
