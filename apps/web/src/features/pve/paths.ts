import type { LinkProps } from "@tanstack/react-router";

/**
 * Paths of VMs and containers of Proxmox VE (Servers & endpoints). The page
 * of one guest sits below the list, so the sidebar keeps the entry highlighted.
 */
export const PVE_PATH = "/virtualization";

/** Who may open the Proxmox VE pages (and so sees the ways there). */
export const PVE_ROLES = ["provider_admin", "tenant_admin"] as const;
export const PVE_GUEST_PATTERN = `${PVE_PATH}/$guestId`;

export function pveTo(): { to: LinkProps["to"] } {
  return { to: PVE_PATH as LinkProps["to"] };
}

export function guestTo(guestId: string): { to: LinkProps["to"] } {
  return { to: `${PVE_PATH}/${encodeURIComponent(guestId)}` as LinkProps["to"] };
}
