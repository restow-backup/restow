/**
 * An IMAP account whose login keeps being refused: when Restow asks "was this account shut
 * down?", and how it resumes.
 *
 * An IMAP object stays `active` (and red) while its login fails. The worker counts failed
 * logins in a few columns of `protected_objects` (migration 0070); after
 * {@link LOGIN_QUESTION_MIN_RUNS} counted failures over at least {@link LOGIN_QUESTION_MIN_HOURS}
 * hours the object gets an open question. Only the admin's "Yes, shut down" turns it into an
 * `orphaned` object with the reason `login_refused` (confirmed at once, a database check keeps
 * every other writer from setting it). A planner in the scheduler then probes the login once
 * every {@link LOGIN_PROBE_INTERVAL_HOURS} hours; when it works again the object is active again.
 *
 * This file holds the constants and the pure rules. The SQL that applies them under the row lock
 * (apps/worker/src/imap-login-state.ts) mirrors {@link nextLoginFailureState} and
 * {@link shouldAskLoginQuestion}; the tests of both sides keep them together.
 */

/** Counted failed logins (no success in between) before the question is raised. */
export const LOGIN_QUESTION_MIN_RUNS = 3;
/** The counted failures must span at least this long (first to now). */
export const LOGIN_QUESTION_MIN_HOURS = 24;
/**
 * A failure of a backup run counts only if the last counted one is at least this old. It folds
 * pg-boss retries and "Back up now" clicks into one run.
 */
export const LOGIN_FAILURE_MIN_SPACING_HOURS = 6;
/**
 * The same for a failed archive capture pass. Passes come every few hours, so a short outage
 * would otherwise count 3 times within the 24 h window; at about a day apart they are runs in
 * the sense of the nightly backup (the question follows after about 2 days, as with backups).
 */
export const LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS = 20;
/** After the admin answered "No", the question comes back at the earliest after this long. */
export const LOGIN_QUESTION_REASK_DAYS = 90;
/** A shut-down (`login_refused`) account is probed this often (7 days). */
export const LOGIN_PROBE_INTERVAL_HOURS = 168;
/** After a probe failed for a doubtful reason (network, server limit), the next one is this far out. */
export const LOGIN_PROBE_RETRY_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * True only for a refused login: `imap.auth_failed`. Not counted: `imap.server_limit` (temporary
 * refusals), `imap.oauth_failed`, `imap.credential_missing`, `imap.starttls_unavailable`,
 * `imap.address_blocked`, `network.*` and `imap.connection_lost`.
 *
 * The "password logins only" rule is not part of this function: the caller often has no account
 * at hand, and an OAuth2 login the server rejects is also `imap.auth_failed`. The SQL that
 * records the failure filters on the source's login (apps/worker/src/imap-login-state.ts).
 */
export function isLoginRefusalCause(
  cause: { readonly code?: string | null } | null | undefined,
): boolean {
  return cause?.code === "imap.auth_failed";
}

/** The counters of one streak of failed logins (`login_failed_runs`, `_since`, `_at`). */
export interface LoginFailureState {
  readonly runs: number;
  /** First counted failure of the streak. */
  readonly since: Date | null;
  /** Last counted failure. */
  readonly lastAt: Date | null;
}

export interface LoginFailureUpdate extends LoginFailureState {
  /** False when the failure came too soon after the last counted one and was folded into it. */
  readonly counted: boolean;
}

/**
 * The state after one more refused login at `now`. `spacingHours` is how old the last counted
 * failure must be ({@link LOGIN_FAILURE_MIN_SPACING_HOURS} for a backup run,
 * {@link LOGIN_ARCHIVE_FAILURE_MIN_SPACING_HOURS} for an archive pass).
 */
export function nextLoginFailureState(
  prev: LoginFailureState,
  now: Date,
  spacingHours: number = LOGIN_FAILURE_MIN_SPACING_HOURS,
): LoginFailureUpdate {
  const spaced =
    prev.lastAt === null || now.getTime() - prev.lastAt.getTime() >= spacingHours * HOUR_MS;
  if (!spaced) {
    return { ...prev, counted: false };
  }
  return {
    runs: prev.runs + 1,
    since: prev.runs > 0 && prev.since ? prev.since : now,
    lastAt: now,
    counted: true,
  };
}

/**
 * Whether the question should be raised now: enough counted failures over enough time, and not
 * answered "No" within the last {@link LOGIN_QUESTION_REASK_DAYS} days. The caller checks that no
 * question is open yet.
 */
export function shouldAskLoginQuestion(
  state: LoginFailureState,
  dismissedAt: Date | null,
  now: Date,
): boolean {
  if (state.runs < LOGIN_QUESTION_MIN_RUNS || state.since === null) {
    return false;
  }
  if (now.getTime() - state.since.getTime() < LOGIN_QUESTION_MIN_HOURS * HOUR_MS) {
    return false;
  }
  return (
    dismissedAt === null ||
    now.getTime() - dismissedAt.getTime() > LOGIN_QUESTION_REASK_DAYS * DAY_MS
  );
}

export type LoginQuestionState = "open" | "dismissed";

/**
 * The login question of an object: `open` (asked, not answered), `dismissed` (answered "No") or
 * null (no question, or the object is not active: an orphaned or excluded object has none).
 */
export function loginQuestionState(object: {
  readonly status: string;
  readonly loginQuestionAt?: Date | string | null;
  readonly loginQuestionDismissedAt?: Date | string | null;
}): LoginQuestionState | null {
  if (object.status !== "active" || !object.loginQuestionAt) {
    return null;
  }
  return object.loginQuestionDismissedAt ? "dismissed" : "open";
}

/** Share of failing accounts (of the active ones on a source) from which it is the source's login. */
export const SOURCE_WIDE_LOGIN_SHARE = 0.5;

/**
 * Whether the login fails for (almost) the whole source: at least two failing accounts and at
 * least half of the active ones. It changes the wording ("check the source's password first")
 * and the notification, never the rule.
 */
export function isSourceWideLoginFailure(failing: number, activeOnSource: number): boolean {
  return failing >= 2 && activeOnSource > 0 && failing >= SOURCE_WIDE_LOGIN_SHARE * activeOnSource;
}
