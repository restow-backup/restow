import type { LinkProps } from "@tanstack/react-router";

import type { SetupItemId } from "./api.js";

/**
 * Where the dashboard links to. Feature routes are registered at runtime, so
 * the static route typing cannot know them (the same approach as the sidebar
 * and the other features); each path is the one its feature registers.
 */
export const PATHS = {
  storage: "/repositories",
  sources: "/sources",
  protectedObjects: "/protected-objects",
  schedules: "/schedules",
  backup: "/backup",
  jobs: "/history",
  verify: "/verify",
  settings: "/settings",
  tenants: "/tenants",
} as const;

export function to(path: string): LinkProps["to"] {
  return path as LinkProps["to"];
}

export function jobTo(jobId: string): LinkProps["to"] {
  return `${PATHS.jobs}/${encodeURIComponent(jobId)}` as LinkProps["to"];
}

export function tenantDetailTo(tenantId: string): LinkProps["to"] {
  return `${PATHS.tenants}/${encodeURIComponent(tenantId)}` as LinkProps["to"];
}

/** The page where each setup step is done. */
export const SETUP_ITEM_PATH: Readonly<Record<SetupItemId, string>> = {
  storage: PATHS.storage,
  source: PATHS.sources,
  objects: PATHS.protectedObjects,
  schedules: PATHS.schedules,
  firstBackup: PATHS.backup,
  firstVerification: PATHS.verify,
  notificationMail: PATHS.settings,
};
