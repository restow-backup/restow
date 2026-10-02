import { createRoute } from "@tanstack/react-router";

import "@/features/settings/i18n";
import { AccountSecurityPage } from "@/features/settings/account-page";
import { ACCOUNT_PATH } from "@/features/settings/paths";
import { appLayoutRoute } from "@/routes/tree";

/**
 * Settings feature: the account page, where every signed-in person manages
 * their own passkeys, authenticator app and sessions (reached from the user
 * menu), and the building blocks of the installation sections (features/
 * installation): the operating mode and public URL with the passkey-ready
 * re-check, the notification mail transport with a test send, and the
 * Microsoft 365 app registration, all for provider admins. The installation
 * page itself, with its menu entry, lives in features/installation.
 */

export const accountRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: ACCOUNT_PATH,
  component: AccountSecurityPage,
});

export const routes = [accountRoute];

/** The account page has no menu entry of its own: the user menu leads there. */
export const navItems = [];
