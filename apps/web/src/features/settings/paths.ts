import { type LinkProps, useNavigate, useRouterState } from "@tanstack/react-router";
import * as React from "react";

import {
  type SettingsSearch,
  type SettingsSection,
  parseSettingsSearch,
  sectionSearch,
} from "@/features/settings/presenters";
import { ACCOUNT_PATH } from "@/lib/entry";

export { ACCOUNT_PATH };

/**
 * Path and URL state of the settings page. Feature routes join the router at
 * integration time and are not part of the statically typed route tree, so the
 * conversion to the router's types happens here, once.
 */

export const SETTINGS_PATH = "/settings";

export function settingsTo(): LinkProps["to"] {
  return SETTINGS_PATH as LinkProps["to"];
}

/** The account page with the signed-in person's own sign-in security. */
export function accountTo(): LinkProps["to"] {
  return ACCOUNT_PATH as LinkProps["to"];
}

/** The settings page's URL state (`?section=`, `?requires=`), validated. */
export function useSettingsSearch(): SettingsSearch {
  const raw = useRouterState({ select: (state) => state.location.search });
  return React.useMemo(() => parseSettingsSearch(raw), [raw]);
}

/** The open section (from `?section=`) and a setter that writes it back. */
export function useSettingsSection(): readonly [SettingsSection, (next: SettingsSection) => void] {
  const section = useSettingsSearch().section ?? "general";
  const navigate = useNavigate();
  const setSection = React.useCallback(
    (next: SettingsSection) => {
      void navigate({ to: settingsTo(), search: sectionSearch(next) as never, replace: true });
    },
    [navigate],
  );
  return [section, setSection] as const;
}
