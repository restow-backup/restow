import type { LinkProps } from "@tanstack/react-router";

import { settingsTo } from "@/features/settings/paths";
import { SETTINGS_PATH } from "@/features/settings/paths";

/** Where the Updates tab lives: Settings, section `updates`. */
export const UPDATES_SECTION = "updates" as const;

export interface UpdatesTabLink {
  to: LinkProps["to"];
  search: never;
}

/** The link target of Settings, Updates (feature routes join the router at runtime, hence the casts). */
export function updatesTabLink(): UpdatesTabLink {
  return { to: settingsTo(), search: { section: UPDATES_SECTION } as never };
}

/** Whether a location is Settings, Updates (the page that carries the recovery steps). */
export function isUpdatesTab(pathname: string, search: unknown): boolean {
  const section =
    typeof search === "object" && search !== null
      ? (search as { section?: unknown }).section
      : null;
  return pathname.replace(/\/+$/, "") === SETTINGS_PATH && section === UPDATES_SECTION;
}
