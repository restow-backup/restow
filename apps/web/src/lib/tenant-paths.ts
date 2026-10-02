import type { LinkProps } from "@tanstack/react-router";

import { getActiveTenantId, readRememberedTenantId } from "@/lib/tenant";

/**
 * Addresses of the tenant page (`/tenants/<id>/<section>`), where everything
 * that belongs to one tenant lives: its connections, protection, jobs, storage,
 * agents, archive settings, notifications, integrations, members, audit log and
 * master data. Pure builders, shared by the tenant page itself and by every
 * page that points into it (the overview, failure explanations, the command
 * palette).
 *
 * Feature routes join the router at runtime and are not part of the statically
 * typed route tree, so the conversion to the router's types happens here.
 */

export const TENANTS_PATH = "/tenants";

/** The sections of the tenant page, in the order of its sub-navigation. Extensions add more (audit log). */
export const TENANT_SECTION_IDS = [
  "overview",
  "connections",
  "protection",
  "jobs",
  "retention",
  "storage",
  "agents",
  "archive",
  "notifications",
  "integrations",
  "members",
  "master-data",
] as const;

export type TenantSectionId = (typeof TENANT_SECTION_IDS)[number];

/** The section the bare tenant address (`/tenants/<id>`) leads to. */
export const DEFAULT_TENANT_SECTION: TenantSectionId = "overview";

/** The tabs of the Connections section (`?tab=`). */
export const CONNECTION_TABS = ["microsoft365", "imap", "google", "imports"] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number];

/** The bare address of a tenant's page, which leads to its first section. */
export function tenantRootPath(tenantId: string): string {
  return `${TENANTS_PATH}/${encodeURIComponent(tenantId)}`;
}

/** `/tenants/<id>/<section>[/<rest>...]`; every segment is encoded. */
export function tenantPagePath(
  tenantId: string,
  section: string,
  ...rest: readonly string[]
): string {
  const tail = rest.map((segment) => `/${encodeURIComponent(segment)}`).join("");
  return `${TENANTS_PATH}/${encodeURIComponent(tenantId)}/${section}${tail}`;
}

/**
 * The tenant the links of a page point into: the active one. Read at render
 * time (the shell publishes it before dependent queries run); on the very
 * first render after loading the page the profile may not have set it yet, so
 * the browser's remembered choice stands in.
 */
function currentTenantId(): string | null {
  return getActiveTenantId() ?? readRememberedTenantId();
}

/**
 * The old address of a page, for the rare render before any tenant is known:
 * the redirect from there (features/redirects) leads to the page of whichever
 * tenant is active once the profile is in.
 */
function legacyPathOf(section: string, rest: readonly string[]): string {
  const tail = rest.slice(1).map(encodeURIComponent);
  const [first, second] = rest;
  switch (section) {
    case "connections":
      if (first === "sources") return ["/sources", ...tail].join("/");
      if (first === "imports")
        return second === "new" ? "/sources/import" : ["/imports", ...tail].join("/");
      return "/sources";
    case "protection":
      return first === "backup" ? "/backup" : "/protected-objects";
    case "jobs":
      return "/schedules";
    case "retention":
      return "/retention";
    case "storage":
      return "/repositories";
    case "integrations":
      return ["/integrations", ...rest.map(encodeURIComponent)].join("/");
    case "members":
      return "/members";
    default:
      return TENANTS_PATH;
  }
}

/** A section of the active tenant's page, as a path. */
export function activeTenantPagePath(section: string, ...rest: readonly string[]): string {
  const tenantId = currentTenantId();
  return tenantId ? tenantPagePath(tenantId, section, ...rest) : legacyPathOf(section, rest);
}

/** `to` for `<Link>` and `navigate`: a section of the active tenant's page. */
export function activeTenantPageTo(section: string, ...rest: readonly string[]): LinkProps["to"] {
  return activeTenantPagePath(section, ...rest) as LinkProps["to"];
}

/** `to` for `<Link>` and `navigate`: a section of the given tenant's page. */
export function tenantPageTo(
  tenantId: string,
  section: string,
  ...rest: readonly string[]
): LinkProps["to"] {
  return tenantPagePath(tenantId, section, ...rest) as LinkProps["to"];
}

/**
 * Where to go after the tenant changed while a tenant page was open: the same
 * section of the new tenant, without anything below it (a source of the
 * previous tenant means nothing in the next). `null` when `pathname` is not on
 * a tenant page.
 */
export function tenantPageAfterSwitch(pathname: string, tenantId: string): string | null {
  const match = /^\/tenants\/[^/]+\/([^/]+)/.exec(pathname.replace(/\/+$/, ""));
  if (!match?.[1]) {
    return null;
  }
  return tenantPagePath(tenantId, match[1]);
}

/** The tenant id and section of a tenant page address, or null for any other address. */
export function parseTenantPagePath(
  pathname: string,
): { tenantId: string; section: string | null } | null {
  const match = /^\/tenants\/([^/]+)(?:\/([^/]+))?/.exec(pathname.replace(/\/+$/, ""));
  if (!match?.[1]) {
    return null;
  }
  try {
    return { tenantId: decodeURIComponent(match[1]), section: match[2] ?? null };
  } catch {
    return null;
  }
}
