import type { LinkProps } from "@tanstack/react-router";

/**
 * Addresses of the module "Databases" (docs/DATABASES.md 2.3), in "Servers & clients" below file
 * shares. Feature routes join the router at runtime, so the conversion to the router's types
 * happens here, once.
 *
 *   /databases                               the databases, the connections and the suggestions
 *   /databases?add=1                         the list with the add dialog open (prefilled from a
 *                                            suggestion with address, endpoint and auth)
 *   /databases/connections/<id>              one connection
 *   /databases/<id>                          one database
 */
export const DATABASES_PATH = "/databases";
export const DATABASE_PATTERN = `${DATABASES_PATH}/$databaseId`;
export const CONNECTION_PATTERN = `${DATABASES_PATH}/connections/$connectionId`;

/** Who may open the pages: administrators change, restore operators read (9). */
export const DATABASE_ROLES = ["provider_admin", "tenant_admin", "tenant_restore"] as const;
/** Who may add, change, test and delete connections. */
export const DATABASE_ADMIN_ROLES = ["provider_admin", "tenant_admin"] as const;

export function databasesTo(): { to: LinkProps["to"] } {
  return { to: DATABASES_PATH as LinkProps["to"] };
}

export function databaseTo(id: string): { to: LinkProps["to"] } {
  return { to: `${DATABASES_PATH}/${encodeURIComponent(id)}` as LinkProps["to"] };
}

export function connectionTo(id: string): { to: LinkProps["to"] } {
  return { to: `${DATABASES_PATH}/connections/${encodeURIComponent(id)}` as LinkProps["to"] };
}

/** A target as `<Link>` and `navigate` take it: the feature routes are not part of the static route types. */
export function linkTo(target: { to: LinkProps["to"]; search?: object }): {
  to: LinkProps["to"];
  search: never;
} {
  return { to: target.to, search: (target.search ?? {}) as never };
}
