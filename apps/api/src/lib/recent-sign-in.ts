import { ProblemError } from "../problem.js";

/**
 * Step-up for the few actions that hand someone the host or a machine
 * (docs/UPDATING.md, "Confirming it is you"; docs/AGENT.md): changing the
 * update source or its access token and announcing an update
 * (features/updates/routes.ts), setting or changing an endpoint's hooks, which
 * run as root on the machine, showing an endpoint's repository password
 * (features/endpoints/routes.ts), and resetting the access of a provider team
 * member, which issues a link into their account (features/provider-team). A session cookie alone is not enough for
 * them; the session must have been opened recently, with the strong sign-in
 * this installation requires anyway (lib/session-assurance.ts): a passkey with user
 * verification, the emergency password together with the authenticator code,
 * or an OIDC sign-in. A session that is older asks the person to confirm with
 * their passkey or to sign in again, which opens a fresh session through the
 * same better-auth endpoints the sign-in page uses (the web app does this in a
 * dialog and repeats the action).
 *
 * The age is the session's own creation time, which better-auth never moves
 * (refreshing a session extends `expiresAt` only), so a stolen or forgotten
 * session cannot renew it.
 */

/** Problem type of an action that needs a recent sign-in. */
export const RECENT_SIGN_IN_PROBLEM = "urn:restow:problem:recent-sign-in-required";

/** How recent the sign-in must be. */
export const RECENT_SIGN_IN_MAX_AGE_SECONDS = 10 * 60;

/** Sign-in methods that count (session-assurance.ts `AUTH_METHODS`); impersonation never does. */
const CONFIRMING_METHODS: ReadonlySet<string> = new Set(["passkey", "password_totp", "oidc"]);

export interface SessionTimes {
  createdAt: Date | string | null | undefined;
  authMethod?: unknown;
}

/** When the session was opened, in epoch milliseconds; null when unknown. */
function openedAt(session: SessionTimes): number | null {
  const value = session.createdAt;
  if (value === null || value === undefined) {
    return null;
  }
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Whether the session was opened with a strong sign-in within the allowed age. */
export function isRecentSignIn(
  session: SessionTimes,
  now: Date,
  maxAgeSeconds = RECENT_SIGN_IN_MAX_AGE_SECONDS,
): boolean {
  const method = typeof session.authMethod === "string" ? session.authMethod : null;
  if (method === null || !CONFIRMING_METHODS.has(method)) {
    return false;
  }
  const opened = openedAt(session);
  if (opened === null) {
    return false;
  }
  const age = now.getTime() - opened;
  // A session from the future (clock skew of a few seconds) counts as new.
  return age <= maxAgeSeconds * 1000 && age >= -60_000;
}

/** 403 {@link RECENT_SIGN_IN_PROBLEM} unless the session was opened recently. */
export function assertRecentSignIn(session: SessionTimes, now: Date = new Date()): void {
  if (isRecentSignIn(session, now)) {
    return;
  }
  throw new ProblemError(403, "Confirm it is you", {
    type: RECENT_SIGN_IN_PROBLEM,
    detail: `This action needs a sign-in from the last ${RECENT_SIGN_IN_MAX_AGE_SECONDS / 60} minutes. Confirm with your passkey, or sign in again, then try again.`,
    extensions: { maxAgeSeconds: RECENT_SIGN_IN_MAX_AGE_SECONDS },
  });
}
