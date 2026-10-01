import type { LinkProps } from "@tanstack/react-router";

/**
 * Paths of the tenants feature. Feature routes are registered at runtime, so
 * the static route typing cannot know them (same approach as the sidebar and
 * the other features).
 */
export const TENANTS_PATH = "/tenants";
export const MEMBERS_PATH = "/members";
export const INVITATIONS_PATH = "/invitations";
export const HOME_PATH = "/";

export function tenantsListTo(): LinkProps["to"] {
  return TENANTS_PATH as LinkProps["to"];
}

export function tenantDetailTo(tenantId: string): LinkProps["to"] {
  return `${TENANTS_PATH}/${encodeURIComponent(tenantId)}` as LinkProps["to"];
}

export function homeTo(): LinkProps["to"] {
  return HOME_PATH as LinkProps["to"];
}

/**
 * The link an invited person opens to accept. It points at the public URL
 * when the installation has one, because the admin may be working through an
 * internal address the invitee cannot reach.
 */
export function invitationLink(baseUrl: string, invitationId: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${INVITATIONS_PATH}/${encodeURIComponent(invitationId)}`;
}
