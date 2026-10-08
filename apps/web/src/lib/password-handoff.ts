/**
 * The password someone just typed, held for the mandatory authenticator
 * enrolment that follows right after (setup wizard, set-password page, a
 * password sign-in of an account without an authenticator app). Starting the
 * enrolment needs the password again (better-auth `twoFactor.enable`); asking
 * for it a second or third time within a minute only teaches people to type
 * it anywhere. So it is handed over instead:
 *
 *   - in this module's memory only, never in storage, a cookie or the URL;
 *   - for one use: whoever takes it, clears it;
 *   - for {@link PASSWORD_HANDOFF_TTL_MS} at most, and dropped on sign-out.
 *
 * When nothing is held (a reload, a later visit) the enrolment simply asks.
 */

export const PASSWORD_HANDOFF_TTL_MS = 5 * 60 * 1000;

let held: { password: string; at: number } | null = null;

/** Hold the password for the enrolment that follows. */
export function holdPasswordForEnrolment(password: string, now: number = Date.now()): void {
  held = password === "" ? null : { password, at: now };
}

/** Take the held password (once); null when none is held or it is too old. */
export function takePasswordForEnrolment(now: number = Date.now()): string | null {
  const current = held;
  held = null;
  if (!current || now - current.at > PASSWORD_HANDOFF_TTL_MS) {
    return null;
  }
  return current.password;
}

/**
 * The held password without taking it (null when none or too old): for a
 * render-time read, where React may run the read twice; take it, or clear
 * it, once the enrolment actually starts.
 */
export function peekPasswordForEnrolment(now: number = Date.now()): string | null {
  if (!held || now - held.at > PASSWORD_HANDOFF_TTL_MS) {
    return null;
  }
  return held.password;
}

/** Forget a held password (sign-out, leaving the enrolment). */
export function clearPasswordHandoff(): void {
  held = null;
}
