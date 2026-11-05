/**
 * The status rule for a set of rated objects (a tenant, a user, a timeline point): which
 * category each object state falls in, how severe each category is, and the aggregate the
 * whole set reads as. This is the single backend source of the rule; the web mirrors it in
 * apps/web/src/components/kit/status-meta.ts and tests the same cases.
 *
 * The five categories (UI rework, decision 1):
 *
 *   ready            `green`      every sampled item came back from a current backup
 *   needs_attention  `yellow`     restorable, but the latest check found something to look at
 *   unverified       `unverified` a backup exists, but no restore check has read it back yet
 *   not_restorable   `red`        a restore would fail or be incomplete today
 *   no_backup        `no_backup`  nothing to restore yet
 *
 * An object an admin confirmed as empty (`empty`) is in none of them: neutral, neither ready
 * nor a problem.
 *
 * The aggregate is the worst category that actually has objects:
 *
 *   red     (Not restorable)  something is not restorable or has no backup yet
 *   yellow  (Not proven)      else something needs attention or is unverified
 *   green   (Ready)           else; also a set of confirmed-empty objects only
 *   null                      nothing to rate
 *
 * Overdue checks, objects in no backup job and objects waiting for a confirmation do not change
 * the aggregate (decision 2); views list them apart as callouts.
 */
import type { RecoveryReadiness } from "../engine/types.js";

/** The state of one rated object: its newest backup's rating, or why it has none. */
export type ReadinessObjectState = RecoveryReadiness | "unverified" | "no_backup" | "empty";

/** The readiness categories, in the order the overview tiles show them. */
export const READINESS_CATEGORIES = [
  "ready",
  "needs_attention",
  "unverified",
  "not_restorable",
  "no_backup",
] as const;

export type ReadinessCategory = (typeof READINESS_CATEGORIES)[number];

/**
 * How severe a status is, worst first. `attention` is something a person must look at;
 * `warning` is something not (yet) proven. The UI maps each severity to one tone.
 */
export type StatusSeverity =
  | "danger"
  | "attention"
  | "warning"
  | "info"
  | "neutral"
  | "success"
  | "muted";

/** The category of each object state; `empty` (confirmed empty) is in none. */
export const READINESS_CATEGORY_OF_STATE: Readonly<
  Record<ReadinessObjectState, ReadinessCategory | null>
> = {
  green: "ready",
  yellow: "needs_attention",
  unverified: "unverified",
  red: "not_restorable",
  no_backup: "no_backup",
  empty: null,
};

export const READINESS_CATEGORY_SEVERITY: Readonly<Record<ReadinessCategory, StatusSeverity>> = {
  ready: "success",
  needs_attention: "attention",
  unverified: "warning",
  not_restorable: "danger",
  no_backup: "danger",
};

/**
 * The severity of an aggregate. Its `yellow` means "Not proven" and is a warning, unlike an
 * object's `yellow` ("Needs attention"), which is an attention.
 */
export const AGGREGATE_SEVERITY: Readonly<Record<RecoveryReadiness, StatusSeverity>> = {
  red: "danger",
  yellow: "warning",
  green: "success",
};

/** Objects per rated state; `empty` is left out, it never decides the aggregate. */
export interface ReadinessStateCounts {
  green: number;
  yellow: number;
  red: number;
  unverified: number;
  noBackup: number;
}

/**
 * The aggregate of a set of rated objects: the worst populated category (see the file header).
 * `rated` counts every rated object, confirmed-empty ones included, so a set of empty objects
 * only reads as `green` and only an empty set as `null`.
 */
export function aggregateReadiness(
  counts: ReadinessStateCounts,
  rated: number,
): RecoveryReadiness | null {
  if (rated === 0) {
    return null;
  }
  if (counts.red > 0 || counts.noBackup > 0) {
    return "red";
  }
  if (counts.yellow > 0 || counts.unverified > 0) {
    return "yellow";
  }
  return "green";
}

/** Counts object states for {@link aggregateReadiness}; `total` includes the empty ones. */
export function countReadinessStates(
  states: Iterable<ReadinessObjectState>,
): ReadinessStateCounts & { empty: number; total: number } {
  const counts = { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0, empty: 0, total: 0 };
  for (const state of states) {
    counts.total += 1;
    if (state === "no_backup") {
      counts.noBackup += 1;
    } else {
      counts[state] += 1;
    }
  }
  return counts;
}

/** Whether a value (from a job payload or an old row) is a rating. */
export function isRecoveryReadiness(value: unknown): value is RecoveryReadiness {
  return value === "green" || value === "yellow" || value === "red";
}
