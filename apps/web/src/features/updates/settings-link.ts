import type { LinkProps } from "@tanstack/react-router";

import { installationSectionPath, installationSectionTo } from "@/features/installation/paths";

/** Where the Updates page lives: Installation, section `updates`. */
export const UPDATES_SECTION = "updates" as const;

export interface UpdatesTabLink {
  to: LinkProps["to"];
  search: never;
}

/** The link target of Installation, Updates (feature routes join the router at runtime, hence the casts). */
export function updatesTabLink(): UpdatesTabLink {
  return { to: installationSectionTo(UPDATES_SECTION), search: {} as never };
}

/** Whether a location is Installation, Updates (the page that carries the recovery steps). */
export function isUpdatesTab(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === installationSectionPath(UPDATES_SECTION);
}
