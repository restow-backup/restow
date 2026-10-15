import type { LinkProps } from "@tanstack/react-router";

/**
 * Addresses of the file shares (docs/FILESHARES.md 12.1), in "Servers & endpoints": the list
 * and one page per share below it, so the menu entry stays highlighted. Feature routes join the
 * router at runtime, so the conversion to the router's types happens here, once.
 *
 *   /file-shares                      the shares, with "Add file share"
 *   /file-shares?add=1                the list with the add dialog open
 *   /file-shares/<id>?tab=…           one share: overview (default), restore-points, runs, settings
 */
export const FILE_SHARES_PATH = "/file-shares";
export const FILE_SHARE_PATTERN = `${FILE_SHARES_PATH}/$shareId`;

/** Who may open the file share pages: tenant admins, and provider admins in a tenant (9.1). */
export const FILE_SHARE_ROLES = ["provider_admin", "tenant_admin"] as const;

export const SHARE_TABS = ["overview", "restore-points", "runs", "settings"] as const;
export type ShareTab = (typeof SHARE_TABS)[number];

export function parseShareTab(value: unknown): ShareTab {
  return (SHARE_TABS as readonly unknown[]).includes(value) ? (value as ShareTab) : "overview";
}

export function fileSharesTo(): { to: LinkProps["to"] } {
  return { to: FILE_SHARES_PATH as LinkProps["to"] };
}

export function fileShareTo(
  shareId: string,
  tab: ShareTab = "overview",
): { to: LinkProps["to"]; search: { tab?: ShareTab } } {
  return {
    to: `${FILE_SHARES_PATH}/${encodeURIComponent(shareId)}` as LinkProps["to"],
    search: tab === "overview" ? {} : { tab },
  };
}

/** A target as `<Link>` takes it: the feature routes are not part of the static route types. */
export function linkTo(target: { to: LinkProps["to"]; search?: object }): {
  to: LinkProps["to"];
  search: never;
} {
  return { to: target.to, search: (target.search ?? {}) as never };
}
