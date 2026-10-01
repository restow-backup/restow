/**
 * Paths of the accounts feature. The set-password page lives outside the app
 * shell (rootRoute, wired directly into router.tsx — see this feature's
 * README-style comment in index.ts), unlike every other feature route.
 */
export const SET_PASSWORD_BASE_PATH = "/accounts/set-password";

/** The address a provisioned person opens to choose their password. */
export function setPasswordLink(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${SET_PASSWORD_BASE_PATH}/${encodeURIComponent(token)}`;
}
