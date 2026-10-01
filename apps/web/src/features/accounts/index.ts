import "./i18n";

/**
 * Accounts feature: provisioning a sign-in for a person without Microsoft
 * SSO. Unlike a sidebar feature it contributes no
 * navigation and no route under the authenticated shell — its surface is the
 * `InviteMemberDialog` / `MembersPanel` it plugs into (tenants feature) and
 * the public `setPasswordRoute` (./route.ts), which hangs off `rootRoute`
 * directly and is wired into `router.tsx` by the integration step, not
 * through `features/registry.ts`.
 */
export const routes = [];
export const navItems = [];

export { setPasswordRoute } from "./route";
