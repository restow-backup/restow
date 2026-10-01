import {
  type CadenceInput,
  type CadenceIssue,
  DEFAULT_SCHEDULE_TIMEZONE,
  validateCadence,
} from "@restow/core";
import { z } from "zod";
import { ProblemError } from "../../problem.js";

/**
 * Request schemas of the schedules feature (same style as apps/api/src/schemas.ts).
 * Shapes are checked here; whether a cadence can run (exactly one of interval
 * and cron, a real zone, a cron expression that matches) is decided by the
 * shared @restow/core code, and every refusal is a 422 problem that names the
 * field to correct.
 */

/**
 * Kinds an administrator can schedule. `archive` exists in the data model but
 * is not offered until a worker handles archive sync runs.
 */
export const OFFERED_SCHEDULE_KINDS = [
  "backup",
  "verify",
  "scrub",
  "directory",
  "retention",
] as const;
export type OfferedScheduleKind = (typeof OFFERED_SCHEDULE_KINDS)[number];

/** Kinds that can be narrowed to one protected object; the others work on the whole tenant. */
export const OBJECT_SCOPED_KINDS: readonly string[] = ["backup", "verify"];

/** Problem type of a schedule that cannot be saved or previewed as sent. */
export const INVALID_SCHEDULE_PROBLEM = "urn:restow:problem:invalid-schedule";

export type ScheduleField = CadenceIssue["field"] | "protectedObjectId" | "kind";

/** A 422 problem naming the field (`field`, and `issues[0].path` like a schema failure). */
export function scheduleProblem(field: ScheduleField, code: string, message: string): ProblemError {
  return new ProblemError(422, "Invalid schedule", {
    type: INVALID_SCHEDULE_PROBLEM,
    detail: `${field}: ${message}`,
    extensions: { field, code, issues: [{ path: [field], code, message }] },
  });
}

/** Throw the problem for the first issue of a cadence, if any. */
export function assertCadenceOrProblem(cadence: CadenceInput, now: Date): void {
  const issue = validateCadence(cadence, now);
  if (issue) {
    throw scheduleProblem(issue.field, issue.code, issue.message);
  }
}

/** Minutes between runs; the range is checked with the cadence. */
const intervalField = z.number().nullable().optional();

/** A five-field cron expression; blank counts as not set. */
const cronField = z
  .string()
  .trim()
  .max(120)
  .nullable()
  .optional()
  .transform((value) => (value === undefined ? undefined : value || null));

const timezoneField = z.string().trim().min(1).max(64);

const protectedObjectField = z.string().uuid().nullable();

export const scheduleKindSchema = z.enum(OFFERED_SCHEDULE_KINDS);

export const createScheduleSchema = z
  .object({
    kind: scheduleKindSchema,
    /** Narrow a backup or verify schedule to one object; null covers every object. */
    protectedObjectId: protectedObjectField.optional().transform((value) => value ?? null),
    intervalMinutes: intervalField,
    cron: cronField,
    timezone: timezoneField.optional().transform((value) => value ?? DEFAULT_SCHEDULE_TIMEZONE),
    enabled: z
      .boolean()
      .optional()
      .transform((value) => value ?? true),
  })
  .strict();
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

/**
 * A partial change. Sending `intervalMinutes` or `cron` replaces the cadence:
 * exactly one of them must then be set, and the other is cleared. The kind of
 * a schedule never changes (delete it and create another).
 */
export const updateScheduleSchema = z
  .object({
    protectedObjectId: protectedObjectField.optional(),
    intervalMinutes: intervalField,
    cron: cronField,
    timezone: timezoneField.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Nothing to update.",
  });
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

export const previewScheduleSchema = z
  .object({
    intervalMinutes: intervalField,
    cron: cronField,
    timezone: timezoneField.optional().transform((value) => value ?? DEFAULT_SCHEDULE_TIMEZONE),
  })
  .strict();
export type PreviewScheduleInput = z.infer<typeof previewScheduleSchema>;

export const applyRecommendedSchema = z
  .object({
    /** Zone of the recommended cron schedules; Europe/Berlin when omitted. */
    timezone: timezoneField.optional().transform((value) => value ?? DEFAULT_SCHEDULE_TIMEZONE),
  })
  .strict();
export type ApplyRecommendedInput = z.infer<typeof applyRecommendedSchema>;

export const scheduleParamSchema = z.object({ id: z.string().uuid() });
