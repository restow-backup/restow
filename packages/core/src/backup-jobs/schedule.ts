// The schedule of a backup job (a mail backup, a restore check, a machine's backup) and what the
// rest of the system derives from it: the cadence the scheduler plans with, the endpoint
// schedule the agent reads, and a key to tell two schedules apart. Pure code, shared by the API
// (validation, preview, migration) and the scheduler.

import type { AgentSchedule } from "../endpoints/config.js";
import {
  type Cadence,
  type CadenceInput,
  isValidTimeZone,
  nextCronOccurrence,
  parseCron,
  validateCadence,
} from "../schedule/index.js";
import type { JobSchedule } from "./types.js";

/** The kinds of job: what a mail job and what an endpoint job are scheduled with differs. */
export type JobKind = "mail" | "endpoint";

/** What is wrong with one field of a job, for a 422 problem and the form behind it. */
export interface JobIssue {
  /** Path of the offending field, e.g. `["schedule", "timeOfDay"]`. */
  readonly path: readonly string[];
  readonly code: string;
  readonly message: string;
}

/** The shortest interval an endpoint schedule may have (the agent contract, docs/AGENT.md). */
export const MIN_ENDPOINT_INTERVAL_MINUTES = 5;
/** The longest one: a week. */
export const MAX_ENDPOINT_INTERVAL_MINUTES = 7 * 24 * 60;

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MINUTE_MS = 60_000;

/** The schedule kinds a job of this kind may use. */
export function scheduleKindsOf(kind: JobKind): readonly JobSchedule["kind"][] {
  return kind === "mail" ? ["interval", "cron", "daily"] : ["interval", "daily", "on_connect"];
}

function issue(path: readonly string[], code: string, message: string): JobIssue {
  return { path, code, message };
}

/**
 * The cadence the scheduler plans a mail schedule with: an interval, a cron
 * expression, or a daily time turned into its cron expression. Null for a
 * schedule a mail job cannot have (`on_connect`) or one that lacks its field.
 */
export function mailCadenceOf(schedule: JobSchedule): Cadence | null {
  switch (schedule.kind) {
    case "interval":
      return typeof schedule.intervalMinutes === "number"
        ? { intervalMinutes: schedule.intervalMinutes, cron: null, timezone: schedule.timeZone }
        : null;
    case "cron":
      return typeof schedule.cron === "string" && schedule.cron.trim().length > 0
        ? { intervalMinutes: null, cron: schedule.cron.trim(), timezone: schedule.timeZone }
        : null;
    case "daily": {
      const match = TIME_OF_DAY.exec(schedule.timeOfDay ?? "");
      if (!match) {
        return null;
      }
      return {
        intervalMinutes: null,
        cron: `${Number(match[2])} ${Number(match[1])} * * *`,
        timezone: schedule.timeZone,
      };
    }
    default:
      return null;
  }
}

/**
 * A mail schedule in its stored form: `daily` becomes the equivalent cron
 * expression so the planner only knows two shapes.
 */
export function normalizeMailSchedule(schedule: JobSchedule): JobSchedule {
  const cadence = mailCadenceOf(schedule);
  if (cadence === null) {
    return schedule;
  }
  return cadence.intervalMinutes !== null
    ? { kind: "interval", intervalMinutes: cadence.intervalMinutes, timeZone: cadence.timezone }
    : { kind: "cron", cron: cadence.cron as string, timeZone: cadence.timezone };
}

/** A stored cadence (the `schedules` columns) as a job schedule. */
export function jobScheduleFromCadence(cadence: Cadence): JobSchedule {
  return cadence.intervalMinutes !== null
    ? { kind: "interval", intervalMinutes: cadence.intervalMinutes, timeZone: cadence.timezone }
    : { kind: "cron", cron: cadence.cron ?? "", timeZone: cadence.timezone };
}

/** The schedule the agent reads (`GET /agent/v1/config`): only the fields its kind uses, in a fixed order. */
export function endpointScheduleOf(schedule: JobSchedule): AgentSchedule {
  switch (schedule.kind) {
    case "daily":
      return {
        kind: "daily",
        timeOfDay: schedule.timeOfDay ?? "00:00",
        timeZone: schedule.timeZone,
      };
    case "on_connect":
      return {
        kind: "on_connect",
        ...(schedule.intervalMinutes !== undefined
          ? { intervalMinutes: schedule.intervalMinutes }
          : {}),
        timeZone: schedule.timeZone,
      };
    default:
      return {
        kind: "interval",
        intervalMinutes: schedule.intervalMinutes ?? MIN_ENDPOINT_INTERVAL_MINUTES,
        timeZone: schedule.timeZone,
      };
  }
}

/** The agent's schedule of a machine as a job schedule (the same shape, so nothing changes). */
export function jobScheduleFromEndpoint(schedule: AgentSchedule): JobSchedule {
  return {
    kind: schedule.kind,
    ...(schedule.intervalMinutes !== undefined
      ? { intervalMinutes: schedule.intervalMinutes }
      : {}),
    ...(schedule.timeOfDay !== undefined ? { timeOfDay: schedule.timeOfDay } : {}),
    timeZone: schedule.timeZone,
  };
}

/**
 * The first problem of a schedule for a job of this kind, or null. `field` names the schedule in
 * the request (`schedule` or `verifySchedule`), so the issue path points at the form field.
 * Mail schedules follow the cadence rules of the schedules page (15 minutes to 31 days, cron at
 * least 15 minutes apart); endpoint schedules the agent contract (5 minutes to a week).
 */
export function validateJobSchedule(
  kind: JobKind,
  schedule: JobSchedule,
  now: Date,
  field = "schedule",
): JobIssue | null {
  if (!scheduleKindsOf(kind).includes(schedule.kind)) {
    return issue(
      [field, "kind"],
      "schedule_kind_not_supported",
      `A ${kind} job cannot use "${schedule.kind}".`,
    );
  }
  if (typeof schedule.timeZone !== "string" || !isValidTimeZone(schedule.timeZone)) {
    return issue(
      [field, "timeZone"],
      "timezone_unknown",
      `"${String(schedule.timeZone)}" is not an IANA time zone such as Europe/Berlin.`,
    );
  }
  if (kind === "mail") {
    const cadence = mailCadenceOf(schedule);
    if (cadence === null) {
      const missing =
        schedule.kind === "interval"
          ? "intervalMinutes"
          : schedule.kind === "cron"
            ? "cron"
            : "timeOfDay";
      return issue([field, missing], "required", `A ${schedule.kind} schedule needs ${missing}.`);
    }
    const input: CadenceInput = cadence;
    const problem = validateCadence(input, now);
    if (problem) {
      const target =
        schedule.kind === "daily"
          ? "timeOfDay"
          : problem.field === "timezone"
            ? "timeZone"
            : problem.field;
      return issue([field, target], problem.code, problem.message);
    }
    return null;
  }
  if (schedule.kind === "daily") {
    return TIME_OF_DAY.test(schedule.timeOfDay ?? "")
      ? null
      : issue([field, "timeOfDay"], "time_of_day_invalid", "Use a time such as 02:30.");
  }
  const minutes = schedule.intervalMinutes;
  if (schedule.kind === "interval" && minutes === undefined) {
    return issue(
      [field, "intervalMinutes"],
      "required",
      "An interval schedule needs intervalMinutes.",
    );
  }
  if (
    minutes !== undefined &&
    (!Number.isInteger(minutes) ||
      minutes < MIN_ENDPOINT_INTERVAL_MINUTES ||
      minutes > MAX_ENDPOINT_INTERVAL_MINUTES)
  ) {
    return issue(
      [field, "intervalMinutes"],
      "interval_out_of_range",
      `The interval must be between ${MIN_ENDPOINT_INTERVAL_MINUTES} minutes and a week.`,
    );
  }
  return null;
}

/** A stable text for a schedule, to tell two apart or group by (kind-specific fields only). */
export function scheduleKey(schedule: JobSchedule | null | undefined): string {
  if (!schedule) {
    return "none";
  }
  switch (schedule.kind) {
    case "interval":
      return `interval:${schedule.intervalMinutes}`;
    case "cron":
      return `cron:${schedule.cron?.trim().replace(/\s+/g, " ")}@${schedule.timeZone}`;
    case "daily":
      return `daily:${schedule.timeOfDay}@${schedule.timeZone}`;
    default:
      return `on_connect:${schedule.intervalMinutes ?? ""}@${schedule.timeZone}`;
  }
}

/** How far ahead {@link scheduleGaps} looks: five weeks show weekly and monthly patterns. */
export const SCHEDULE_GAP_HORIZON_MINUTES = 35 * 24 * 60;
/** More runs than this in the horizon are not walked; the gaps then count as unknown. */
const SCHEDULE_GAP_RUN_LIMIT = 4000;

/** The shortest and the longest time between two runs of a schedule, in minutes. */
export interface ScheduleGaps {
  readonly min: number;
  /** The longest stretch without a run: what an object can lose when it fails just before. */
  readonly max: number;
}

/**
 * The shortest and longest gap between two runs of a mail schedule, looked at over every run in
 * the next five weeks (and the one after them), so a schedule that pauses at night, at the
 * weekend or for most of the month shows that pause. Null for a schedule that cannot be planned
 * or whose runs were too many to walk. An interval has one gap.
 */
export function scheduleGaps(schedule: JobSchedule, now: Date): ScheduleGaps | null {
  const cadence = mailCadenceOf(schedule);
  if (cadence === null || validateCadence(cadence, now) !== null) {
    return null;
  }
  if (cadence.intervalMinutes !== null) {
    return { min: cadence.intervalMinutes, max: cadence.intervalMinutes };
  }
  const spec = parseCron(cadence.cron as string);
  const end = now.getTime() + SCHEDULE_GAP_HORIZON_MINUTES * MINUTE_MS;
  let previous = nextCronOccurrence(spec, now, cadence.timezone);
  if (previous === null) {
    return null;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let runs = 0; previous.getTime() <= end; runs++) {
    if (runs >= SCHEDULE_GAP_RUN_LIMIT) {
      return null;
    }
    const next = nextCronOccurrence(spec, previous, cadence.timezone);
    if (next === null) {
      // No further run within the five years the cron search looks at.
      return { min, max: Number.POSITIVE_INFINITY };
    }
    const gap = (next.getTime() - previous.getTime()) / MINUTE_MS;
    min = Math.min(min, gap);
    max = Math.max(max, gap);
    previous = next;
  }
  return { min, max };
}

/**
 * Whether `own` protects an object at least as well as `base` on its own: its longest pause is
 * no longer than the shortest gap of `base`, so between any two runs of `base` there is a run of
 * `own` (and never a longer stretch without one). Comparing the shortest gaps alone is not enough:
 * "every 30 minutes during office hours" runs closer together than "daily at 02:00" but leaves
 * every weekend without a backup. Unknown gaps count as "no".
 */
export function runsAtLeastAsOften(own: ScheduleGaps | null, base: ScheduleGaps | null): boolean {
  return own !== null && base !== null && own.max <= base.min;
}
