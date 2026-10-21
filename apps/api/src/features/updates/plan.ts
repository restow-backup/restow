import { zonedTimeToUtc } from "@restow/core";
import { type Database, type PlannedUpdate, settings } from "@restow/db";
import { and, isNotNull, sql } from "drizzle-orm";

/**
 * An update at a chosen time (0.4.2, docs/UPDATING.md "At a chosen time"). The administrator
 * picks a date and a time in the installation's time zone (lib/installation-time-zone.ts) instead of a lead time from now. The
 * api keeps the plan in `settings.planned_update` and, `leadSeconds` before the chosen time,
 * confirms it the way the install dialog would have (same checks, same pause of new job starts,
 * same countdown for everybody), so nothing pauses or waits before. The updater is not involved
 * until then.
 */

/** How far ahead an update can be planned. */
export const PLAN_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** A plan whose moment is more than this past (the api was down) is dropped, not started. */
export const PLAN_LATE_LIMIT_MS = 60 * 60 * 1000;
/** The plan must lie at least this far ahead of its own lead time. */
export const PLAN_MIN_AHEAD_MS = 60 * 1000;

export type PlanTimeResult =
  | { ok: true; startsAt: Date }
  | { ok: false; reason: "invalid" | "nonexistent" | "past" | "too_far" };

/** The instant of a wall-clock date and time in `timeZone`, checked against `now`. */
export function plannedStartsAt(
  at: { date: string; time: string },
  timeZone: string,
  leadSeconds: number,
  now: Date,
): PlanTimeResult {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at.date);
  const time = /^(\d{2}):(\d{2})$/.exec(at.time);
  if (!date || !time) {
    return { ok: false, reason: "invalid" };
  }
  const parts = {
    year: Number(date[1]),
    month: Number(date[2]),
    day: Number(date[3]),
    hour: Number(time[1]),
    minute: Number(time[2]),
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour > 23 ||
    parts.minute > 59
  ) {
    return { ok: false, reason: "invalid" };
  }
  const startsAt = zonedTimeToUtc(parts, timeZone);
  if (!startsAt) {
    // The wall time does not exist (the hour skipped when daylight saving time begins).
    return { ok: false, reason: "nonexistent" };
  }
  const handover = startsAt.getTime() - leadSeconds * 1000;
  if (handover < now.getTime() + PLAN_MIN_AHEAD_MS) {
    return { ok: false, reason: "past" };
  }
  if (startsAt.getTime() > now.getTime() + PLAN_MAX_AHEAD_MS) {
    return { ok: false, reason: "too_far" };
  }
  return { ok: true, startsAt };
}

/** When the plan is to be confirmed: its lead time before the chosen moment. */
export function handoverAt(plan: Pick<PlannedUpdate, "startsAt" | "leadSeconds">): number {
  return Date.parse(plan.startsAt) - plan.leadSeconds * 1000;
}

export async function loadPlan(db: Database): Promise<PlannedUpdate | null> {
  const [row] = await db
    .select({ plan: settings.plannedUpdate })
    .from(settings)
    .where(isNotNull(settings.plannedUpdate))
    .limit(1);
  return row?.plan ?? null;
}

export async function storePlan(db: Database, plan: PlannedUpdate): Promise<void> {
  await db
    .update(settings)
    .set({ plannedUpdate: plan, updatedAt: sql`${settings.updatedAt}` })
    .where(sql`true`);
}

/**
 * Take the plan off the row; only the caller that sees it with this `plannedAt` wins (two api
 * processes never both confirm it). Returns whether this call removed it.
 */
export async function takePlan(db: Database, plannedAt: string | null): Promise<boolean> {
  const removed = await db
    .update(settings)
    .set({ plannedUpdate: null, updatedAt: sql`${settings.updatedAt}` })
    .where(
      and(
        isNotNull(settings.plannedUpdate),
        plannedAt === null
          ? undefined
          : sql`${settings.plannedUpdate}->>'plannedAt' = ${plannedAt}`,
      ),
    )
    .returning({ id: settings.id });
  return removed.length > 0;
}
