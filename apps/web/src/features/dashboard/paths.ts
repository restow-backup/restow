import type { LinkProps } from "@tanstack/react-router";

import { activeTenantPagePath, tenantPageTo } from "@/lib/tenant-paths";

import type { SetupItemId } from "./api.js";

/**
 * Where the dashboard links to. Feature routes are registered at runtime, so
 * the static route typing cannot know them (the same approach as the sidebar
 * and the other features); each path is the one its feature registers.
 */
export const PATHS = {
  // The pages of the active tenant (its page, features/tenant-page): read when a link is
  // drawn, so a link always points into the tenant that is active then.
  get storage() {
    return activeTenantPagePath("storage");
  },
  get sources() {
    return activeTenantPagePath("connections");
  },
  get protectedObjects() {
    return activeTenantPagePath("protection");
  },
  get schedules() {
    return activeTenantPagePath("jobs");
  },
  get backup() {
    return activeTenantPagePath("protection", "backup");
  },
  jobs: "/history",
  warnings: "/warnings",
  verify: "/verify",
  notificationMailSettings: "/installation/mail",
  tenants: "/tenants",
} as const;

export function to(path: string): LinkProps["to"] {
  return path as LinkProps["to"];
}

export function jobTo(jobId: string): LinkProps["to"] {
  return `${PATHS.jobs}/${encodeURIComponent(jobId)}` as LinkProps["to"];
}

export function tenantDetailTo(tenantId: string): LinkProps["to"] {
  return tenantPageTo(tenantId, "overview");
}

/** The page where each setup step is done. */
export function setupItemPath(id: SetupItemId): string {
  const paths: Readonly<Record<SetupItemId, string>> = {
    storage: PATHS.storage,
    source: PATHS.sources,
    objects: PATHS.protectedObjects,
    schedules: PATHS.schedules,
    firstBackup: PATHS.backup,
    firstVerification: PATHS.verify,
    notificationMail: PATHS.notificationMailSettings,
  };
  return paths[id];
}
