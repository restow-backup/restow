import { Activity, ListChecks } from "lucide-react";

import type { NavItem } from "@/lib/navigation";

/**
 * Menu entries whose feature comes with a later release (maintainer decision
 * 2026-10-01: the final menu ships with 0.1.0, nothing has to be rebuilt
 * later). Each entry sits at the address the feature will have, shows a
 * "Soon" badge and opens a short placeholder page that says what it will do
 * and when. Roles and sections are those of the finished feature.
 */

/** Path of the job definitions (0.2.0); without `?type=` it leads to History. */
export const JOBS_PATH = "/jobs";
export const RESOURCES_PATH = "/resources";

const OPERATOR_ROLES = ["provider_admin", "tenant_admin"] as const;

/** What the placeholder page of an entry says, by nav item id (keys under `soon.` in common). */
export const SOON_CONTENT: Readonly<Record<string, string>> = {
  "mail-jobs": "mailJobs",
  "endpoint-jobs": "endpointJobs",
  resources: "resources",
};

export const JOB_TYPES = ["mail", "endpoint"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

export const soonNavItems: NavItem[] = [
  {
    id: "mail-jobs",
    path: JOBS_PATH,
    search: { type: "mail" },
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    roles: [...OPERATOR_ROLES],
    group: "mail",
    order: 10,
    soon: "0.2.0",
  },
  {
    id: "endpoint-jobs",
    path: JOBS_PATH,
    search: { type: "endpoint" },
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    roles: [...OPERATOR_ROLES],
    group: "endpoints",
    order: 10,
    soon: "0.2.0",
  },
  {
    id: "resources",
    path: RESOURCES_PATH,
    labelKey: "nav.items.resources",
    icon: Activity,
    // Installation-wide load and workers: provider admins (plan step 13).
    roles: ["provider_admin"],
    group: "admin",
    order: 100,
    soon: "0.2.1",
  },
];

/** The upcoming entry of a jobs type. */
export function jobsSoonItem(type: JobType): NavItem {
  const id = type === "mail" ? "mail-jobs" : "endpoint-jobs";
  const item = soonNavItems.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`no upcoming entry ${id}`);
  }
  return item;
}

export function resourcesSoonItem(): NavItem {
  const item = soonNavItems.find((candidate) => candidate.id === "resources");
  if (!item) {
    throw new Error("no upcoming entry resources");
  }
  return item;
}
