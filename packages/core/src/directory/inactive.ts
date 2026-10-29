/**
 * The confirmation state of an object Restow stopped backing up because the source says it is
 * gone, disabled, unlicensed or locked (status `orphaned`, with or without `status_reason`).
 *
 *   - `to_confirm`: amber "Not backed up any more, please confirm". No failure, no red, no
 *     overdue, but it needs attention (warnings, dashboard and readiness read yellow, not green)
 *     until an admin decides.
 *   - `confirmed`: grey "Intentionally no longer backed up, confirmed by <who> on <date>".
 *     Neutral, counts for nothing.
 *   - null: any other object (active, excluded), shown as usual.
 *
 * Postgres keeps the lifecycle (migration 0069 trigger): every transition into `orphaned` starts
 * unconfirmed (except from `excluded`, which counts as confirmed: it was never backed up),
 * every transition out of it drops the confirmation, so an object that comes back
 * (enabled, licensed, unlocked, back in the source) and leaves again asks once more.
 */

export type InactiveState = "to_confirm" | "confirmed";

/** Confirmation author stored for objects orphaned before 0.4.7 (migration 0069 backfill). */
export const MIGRATION_CONFIRMED_BY = "migration";

/**
 * Confirmation author the 0069 trigger stores when an excluded object turns orphaned: Restow
 * never backed it up, so nothing stopped and there is nothing to confirm or notify.
 */
export const EXCLUDED_CONFIRMED_BY = "excluded";

/** The confirmation state of an object, from its status and confirmation date. */
export function inactiveState(object: {
  readonly status: string;
  readonly statusConfirmedAt?: Date | string | null;
}): InactiveState | null {
  if (object.status !== "orphaned") {
    return null;
  }
  return object.statusConfirmedAt ? "confirmed" : "to_confirm";
}

/**
 * Whether one sync (or day) made so many objects of a tenant inactive at once that a single
 * warning should replace the one-time notices: more than 10 objects, or more than 20% of the
 * tenant's objects that were active before (`activeNow` still active plus the `recent` ones).
 * The share needs at least two objects: one mailbox of a three-person tenant is one notice, not
 * a mass event.
 */
export const MANY_INACTIVE_COUNT = 10;
export const MANY_INACTIVE_SHARE = 0.2;

export function isManyInactive(recent: number, activeNow: number): boolean {
  if (recent <= 0) {
    return false;
  }
  return (
    recent > MANY_INACTIVE_COUNT ||
    (recent >= 2 && recent > MANY_INACTIVE_SHARE * (activeNow + recent))
  );
}
