import { createRoute } from "@tanstack/react-router";
import { Settings } from "lucide-react";

import "@/features/settings/i18n";
import { AccountSecurityPage } from "@/features/settings/account-page";
import { ACCOUNT_PATH, SETTINGS_PATH } from "@/features/settings/paths";
import { parseSettingsSearch } from "@/features/settings/presenters";
import { SETTINGS_ROLES, SettingsPage } from "@/features/settings/settings-page";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

/**
 * Settings feature: the installation's operating mode and public URL (with the
 * passkey-ready re-check), the notification mail transport with a test send
 * and a danger zone, for provider admins only; plus the account page, where
 * every signed-in person manages their own passkeys, authenticator app and
 * sessions (reached from the user menu).
 */

export const settingsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: SETTINGS_PATH,
  validateSearch: (search: Record<string, unknown>) => parseSettingsSearch(search),
  component: SettingsPage,
});

export const accountRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: ACCOUNT_PATH,
  component: AccountSecurityPage,
});

export const routes = [settingsRoute, accountRoute];

export const navItems: NavItem[] = [
  {
    id: "settings",
    path: SETTINGS_PATH,
    labelKey: "settings:nav",
    icon: Settings,
    roles: [...SETTINGS_ROLES],
    group: "admin",
    order: 90,
  },
];
