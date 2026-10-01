/**
 * First-run and sign-in routing decisions, kept pure so they can be tested
 * without a router. The root route consults `resolveEntryRedirect` on every
 * navigation; the app shell consults `resolveAuthRedirect`.
 */

export const SETUP_PATH = "/setup" as const;
export const LOGIN_PATH = "/login" as const;
export const HOME_PATH = "/" as const;
/** Mandatory authenticator enrolment for accounts that sign in with a password. */
export const AUTHENTICATOR_SETUP_PATH = "/authenticator-setup" as const;
/** The signed-in person's own sign-in security (passkeys, authenticator app, sessions). */
export const ACCOUNT_PATH = "/account" as const;

export type EntryRedirect = typeof SETUP_PATH | typeof HOME_PATH;

function normalize(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * Until the installation is configured every path leads to the wizard; once
 * configured the wizard itself is closed (the API answers 409 anyway).
 */
export function resolveEntryRedirect(configured: boolean, pathname: string): EntryRedirect | null {
  const path = normalize(pathname);
  if (!configured) {
    return path === SETUP_PATH ? null : SETUP_PATH;
  }
  return path === SETUP_PATH ? HOME_PATH : null;
}

/**
 * Where an unauthenticated visitor of `href` is sent, remembering the target
 * so the login page can return there. Only app-internal paths are kept.
 */
export function loginRedirectFor(href: string): { to: typeof LOGIN_PATH; redirect?: string } {
  const target = safeRedirectTarget(href);
  return target && target !== HOME_PATH ? { to: LOGIN_PATH, redirect: target } : { to: LOGIN_PATH };
}

/**
 * Accept only same-app absolute paths as post-login targets; anything else
 * (external URLs, protocol-relative, the auth pages themselves) falls back
 * to the home page so the redirect parameter cannot be abused.
 */
export function safeRedirectTarget(candidate: string | null | undefined): string | null {
  if (!candidate) {
    return null;
  }
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return null;
  }
  const path = normalize(candidate.split("?")[0] ?? "/");
  if (path === LOGIN_PATH || path === SETUP_PATH || path === AUTHENTICATOR_SETUP_PATH) {
    return null;
  }
  return candidate;
}
