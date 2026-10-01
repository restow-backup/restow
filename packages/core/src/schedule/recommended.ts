// Which recommended schedules a tenant is still missing. Shared by the
// scheduler (which applies them once per tenant) and the API (which lists the
// missing ones and applies them on request), so both decide alike.

import { type Cadence, scrubModeForCadence } from "./cadence.js";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  RECOMMENDED_SCHEDULE_DEFAULTS,
  type RecommendedScheduleDefault,
  type RecommendedSlot,
} from "./defaults.js";

/** What a schedule enqueues (mirrors the `schedule_kind` enum of @restow/db). */
export const SCHEDULE_KINDS = [
  "backup",
  "verify",
  "retention",
  "scrub",
  "directory",
  "archive",
] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** A recommended schedule, ready to insert. */
export interface RecommendedSchedule extends Cadence {
  readonly slot: RecommendedSlot;
  readonly kind: RecommendedScheduleDefault["kind"];
}

export interface RecommendationContext {
  /** Zone for the cron entries; {@link DEFAULT_SCHEDULE_TIMEZONE} when omitted. */
  readonly timezone?: string;
  /** Whether the tenant has a Microsoft 365 source (directory sync is only recommended then). */
  readonly hasMicrosoftSource: boolean;
}

/** The recommended schedules for a tenant, in the order they are listed. */
export function recommendedSchedules(context: RecommendationContext): RecommendedSchedule[] {
  const timezone = context.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
  return RECOMMENDED_SCHEDULE_DEFAULTS.filter(
    (entry) => !entry.requiresMicrosoftSource || context.hasMicrosoftSource,
  ).map((entry) => ({
    slot: entry.slot,
    kind: entry.kind,
    intervalMinutes: entry.intervalMinutes,
    cron: entry.cron,
    timezone,
  }));
}

/** The columns of an existing schedule that decide whether it covers a recommendation. */
export interface ExistingSchedule {
  readonly kind: ScheduleKind;
  readonly protectedObjectId: string | null;
  readonly intervalMinutes: number | null;
  readonly cron: string | null;
}

/**
 * Whether an existing schedule already does what a recommendation would: the
 * same kind for the whole tenant (a schedule narrowed to one object does not
 * protect the others) and, for scrubs, the same mode (sampled or full).
 * Disabled schedules count: switching one off is a decision, not a gap.
 */
export function coversRecommendation(
  existing: ExistingSchedule,
  recommendation: RecommendedSchedule,
): boolean {
  if (existing.kind !== recommendation.kind || existing.protectedObjectId !== null) {
    return false;
  }
  return (
    recommendation.kind !== "scrub" ||
    scrubModeForCadence(existing) === scrubModeForCadence(recommendation)
  );
}

/** The recommendations none of the existing schedules covers. */
export function missingRecommendedSchedules(
  existing: readonly ExistingSchedule[],
  recommended: readonly RecommendedSchedule[],
): RecommendedSchedule[] {
  return recommended.filter(
    (recommendation) =>
      !existing.some((schedule) => coversRecommendation(schedule, recommendation)),
  );
}

/** The kinds of the given recommendations, once each, in order. */
export function kindsOfRecommendations(
  recommended: readonly RecommendedSchedule[],
): ScheduleKind[] {
  return [...new Set(recommended.map((entry) => entry.kind))];
}
