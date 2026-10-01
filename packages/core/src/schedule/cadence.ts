// The cadence of a schedule — a fixed interval or a cron expression in an
// IANA time zone, exactly one of the two — and the arithmetic every writer of
// `schedules` shares: validation with the offending field named, the first
// run after the cadence was set, the next runs for a preview and the scrub
// mode a cadence implies. The scheduler advances a schedule after each run on
// its own (apps/scheduler planning); this module answers "when does it run
// next" at the moment a schedule is created, changed or switched back on.

import type { ScrubMode } from "../verify/integrity.js";
import { CronSyntaxError, isValidTimeZone, nextCronOccurrence, parseCron } from "./cron.js";

/** How often a schedule runs: `intervalMinutes` or `cron` (in `timezone`), never both. */
export interface Cadence {
  readonly intervalMinutes: number | null;
  readonly cron: string | null;
  /** IANA zone the cron expression is evaluated in (ignored for intervals). */
  readonly timezone: string;
}

/** Shortest interval a schedule may use; cron runs closer together are rejected as well. */
export const MIN_INTERVAL_MINUTES = 15;
/** Longest interval a schedule may use (31 days); rarer runs are expressed as cron. */
export const MAX_INTERVAL_MINUTES = 31 * 24 * 60;
/** A scrub that runs this rarely (or less often) checks every pack instead of a sample. */
export const FULL_SCRUB_INTERVAL_MINUTES = 28 * 24 * 60;
/** How many upcoming runs a preview lists. */
export const PREVIEW_RUN_COUNT = 5;

const MINUTE_MS = 60_000;

/** The request field a cadence problem belongs to. */
export type CadenceField = "intervalMinutes" | "cron" | "timezone";

export type CadenceIssueCode =
  | "cadence_missing"
  | "cadence_ambiguous"
  | "interval_not_integer"
  | "interval_out_of_range"
  | "cron_invalid"
  | "cron_never_matches"
  | "cron_too_frequent"
  | "timezone_unknown";

/** Why a cadence cannot be used, naming the field to correct. */
export interface CadenceIssue {
  readonly field: CadenceField;
  readonly code: CadenceIssueCode;
  readonly message: string;
}

/** Thrown when a cadence is used that {@link validateCadence} rejects. */
export class CadenceError extends Error {
  readonly issue: CadenceIssue;

  constructor(issue: CadenceIssue) {
    super(`${issue.field}: ${issue.message}`);
    this.name = "CadenceError";
    this.issue = issue;
  }
}

/** A cadence as it arrives from a request: either member may be absent. */
export interface CadenceInput {
  readonly intervalMinutes?: number | null;
  readonly cron?: string | null;
  readonly timezone: string;
}

function issue(field: CadenceField, code: CadenceIssueCode, message: string): CadenceIssue {
  return { field, code, message };
}

/**
 * The first problem of a cadence, or null when it can be scheduled. Checks, in
 * order: exactly one of interval and cron, a known time zone, an integer
 * interval within {@link MIN_INTERVAL_MINUTES}..{@link MAX_INTERVAL_MINUTES},
 * and a cron expression that parses, matches within five years of `now` and
 * never fires more often than the minimum interval.
 */
export function validateCadence(input: CadenceInput, now: Date = new Date()): CadenceIssue | null {
  const interval = input.intervalMinutes ?? null;
  const cron = input.cron?.trim() || null;
  if (interval !== null && cron !== null) {
    return issue(
      "intervalMinutes",
      "cadence_ambiguous",
      "Set either intervalMinutes or cron, not both.",
    );
  }
  if (interval === null && cron === null) {
    return issue("intervalMinutes", "cadence_missing", "Set either intervalMinutes or cron.");
  }
  if (!isValidTimeZone(input.timezone)) {
    return issue(
      "timezone",
      "timezone_unknown",
      `"${input.timezone}" is not an IANA time zone such as Europe/Berlin.`,
    );
  }
  if (interval !== null) {
    if (!Number.isInteger(interval)) {
      return issue(
        "intervalMinutes",
        "interval_not_integer",
        "The interval must be whole minutes.",
      );
    }
    if (interval < MIN_INTERVAL_MINUTES || interval > MAX_INTERVAL_MINUTES) {
      return issue(
        "intervalMinutes",
        "interval_out_of_range",
        `The interval must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES} minutes.`,
      );
    }
    return null;
  }
  return cronIssue(cron as string, input.timezone, now);
}

function cronIssue(cron: string, timezone: string, now: Date): CadenceIssue | null {
  let spec: ReturnType<typeof parseCron>;
  try {
    spec = parseCron(cron);
  } catch (error) {
    const reason = error instanceof CronSyntaxError ? error.message : "invalid expression";
    return issue("cron", "cron_invalid", `Not a five-field cron expression (${reason}).`);
  }
  // A few consecutive runs are enough to see an expression that fires too
  // often: its short gap shows up between two neighbouring runs.
  const runs: Date[] = [];
  let after = now;
  for (let i = 0; i < PREVIEW_RUN_COUNT; i++) {
    const next = nextCronOccurrence(spec, after, timezone);
    if (next === null) {
      break;
    }
    runs.push(next);
    after = next;
  }
  if (runs.length === 0) {
    return issue("cron", "cron_never_matches", "The expression never matches a date.");
  }
  for (let i = 1; i < runs.length; i++) {
    const gap = ((runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime()) / MINUTE_MS;
    if (gap < MIN_INTERVAL_MINUTES) {
      return issue(
        "cron",
        "cron_too_frequent",
        `Runs must be at least ${MIN_INTERVAL_MINUTES} minutes apart.`,
      );
    }
  }
  return null;
}

/** Throw {@link CadenceError} unless the cadence is valid; returns it normalised. */
export function assertCadence(input: CadenceInput, now: Date = new Date()): Cadence {
  const problem = validateCadence(input, now);
  if (problem) {
    throw new CadenceError(problem);
  }
  return {
    intervalMinutes: input.intervalMinutes ?? null,
    cron: input.cron?.trim() || null,
    timezone: input.timezone,
  };
}

export interface NextRunContext {
  /** The moment the cadence is set (creation, change, re-enabling). */
  readonly now: Date;
  /** When the schedule last ran; null for a schedule that never ran. */
  readonly lastRunAt?: Date | null;
}

/**
 * When a schedule runs next, right after its cadence was set. An interval
 * counts from the last run, so a schedule that never ran (or is overdue) is
 * due at once: "every 8 hours" starts protecting now, not in 8 hours. A cron
 * schedule runs at its next wall-clock match in its zone, never "now" just
 * because it was edited. Throws {@link CadenceError} for an invalid cadence.
 */
export function nextRunAt(input: CadenceInput, context: NextRunContext): Date {
  const cadence = assertCadence(input, context.now);
  if (cadence.intervalMinutes !== null) {
    const lastRunAt = context.lastRunAt ?? null;
    if (lastRunAt === null) {
      return new Date(context.now.getTime());
    }
    const due = lastRunAt.getTime() + cadence.intervalMinutes * MINUTE_MS;
    return new Date(Math.max(due, context.now.getTime()));
  }
  const next = nextCronOccurrence(parseCron(cadence.cron as string), context.now, cadence.timezone);
  if (next === null) {
    // assertCadence has seen a match from `now`; this is unreachable in practice.
    throw new CadenceError(
      issue("cron", "cron_never_matches", "The expression never matches a date."),
    );
  }
  return next;
}

/**
 * The next `count` runs of a cadence (default {@link PREVIEW_RUN_COUNT}),
 * starting with {@link nextRunAt}. Cron runs follow the zone's wall clock, so
 * a daily 03:00 stays at 03:00 local time across a daylight-saving switch.
 */
export function upcomingRuns(
  input: CadenceInput,
  context: NextRunContext & { readonly count?: number },
): Date[] {
  const count = context.count ?? PREVIEW_RUN_COUNT;
  const cadence = assertCadence(input, context.now);
  const first = nextRunAt(cadence, context);
  const runs = [first];
  if (cadence.intervalMinutes !== null) {
    for (let i = 1; i < count; i++) {
      runs.push(new Date(first.getTime() + i * cadence.intervalMinutes * MINUTE_MS));
    }
    return runs;
  }
  const spec = parseCron(cadence.cron as string);
  while (runs.length < count) {
    const next = nextCronOccurrence(spec, runs[runs.length - 1] as Date, cadence.timezone);
    if (next === null) {
      break;
    }
    runs.push(next);
  }
  return runs;
}

/**
 * The scrub mode a cadence implies: rare scrubs check every pack, frequent
 * ones a sample. An interval of four weeks or more is rare; a cron expression
 * that names days of the month ("on the 1st") is monthly and therefore rare.
 * An unreadable cadence falls back to the cheap sample.
 */
export function scrubModeForCadence(cadence: Pick<Cadence, "intervalMinutes" | "cron">): ScrubMode {
  if (cadence.intervalMinutes !== null) {
    return cadence.intervalMinutes >= FULL_SCRUB_INTERVAL_MINUTES ? "full" : "sample";
  }
  try {
    return parseCron(cadence.cron ?? "").anyDayOfMonth ? "sample" : "full";
  } catch {
    return "sample";
  }
}
