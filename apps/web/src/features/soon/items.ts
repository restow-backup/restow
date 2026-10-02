import { Activity } from "lucide-react";

import type { NavItem } from "@/lib/navigation";

/**
 * Menu entries whose feature comes with a later release (maintainer decision
 * 2026-10-01: the final menu ships with 0.1.0, nothing has to be rebuilt
 * later). Each entry sits at the address the feature will have, shows a
 * "Soon" badge and opens a short placeholder page that says what it will do
 * and when. Roles and sections are those of the finished feature.
 *
 * The job definitions (`/jobs?type=mail|endpoint`) were in this list until
 * 0.2.0; they are a feature of their own now (features/backup-jobs).
 */

/** Capacity planning (0.5.0); the address and the entry id are those the menu has always had. */
export const RESOURCES_PATH = "/resources";

/** What the placeholder page of an entry says, by nav item id (keys under `soon.` in common). */
export const SOON_CONTENT: Readonly<Record<string, string>> = {
  resources: "resources",
};

export const soonNavItems: NavItem[] = [
  {
    id: "resources",
    path: RESOURCES_PATH,
    labelKey: "nav.items.resources",
    icon: Activity,
    // Capacity planning (utilisation and growth per tenant and repository): provider admins.
    roles: ["provider_admin"],
    group: "installation",
    order: 50,
    soon: "0.5.0",
  },
];

export function resourcesSoonItem(): NavItem {
  const item = soonNavItems.find((candidate) => candidate.id === "resources");
  if (!item) {
    throw new Error("no upcoming entry resources");
  }
  return item;
}
