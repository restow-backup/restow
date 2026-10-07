import { z } from "zod";
import { ProblemError } from "../../problem.js";
import {
  absolutePath,
  bandwidthWindowsSchema,
  excludePattern,
  hookCommand,
  retentionSchema,
} from "../endpoints/schemas.js";

/**
 * Request schemas of the backup jobs feature (docs/ARCHITECTURE.md, "Jobs"). Shapes are checked
 * here; whether a schedule can run, whether an object may join a job and whether a machine
 * allows the hooks is decided by the service, and every refusal is a problem that names the
 * field (`field`, `issues[0].path`) so the form can show it where it belongs.
 */

const uuid = z.string().uuid();

/** Problem type of a job that cannot be saved as sent. */
export const INVALID_JOB_PROBLEM = "urn:restow:problem:invalid-backup-job";
/** Problem type of an object or machine that already belongs to another job. */
export const IN_OTHER_JOB_PROBLEM = "urn:restow:problem:backup-job-member-in-other-job";
/** Problem type of a change that needs a state the job does not have (disabled, not a machine job). */
export const JOB_STATE_PROBLEM = "urn:restow:problem:backup-job-state";

/** A 422 problem naming the field (`field`, and `issues[0].path` like a schema failure). */
export function jobProblem(
  path: readonly string[],
  code: string,
  message: string,
  extensions: Record<string, unknown> = {},
): ProblemError {
  return new ProblemError(422, "Invalid backup job", {
    type: INVALID_JOB_PROBLEM,
    detail: `${path.join(".")}: ${message}`,
    extensions: {
      field: path[0],
      code,
      issues: [{ path: [...path], code, message }],
      ...extensions,
    },
  });
}

export const jobKindSchema = z.enum(["mail", "endpoint"]);

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

export const jobScheduleSchema = z.object({
  kind: z.enum(["interval", "cron", "daily", "on_connect"]),
  intervalMinutes: z
    .number()
    .int()
    .min(1)
    .max(31 * 24 * 60)
    .optional(),
  cron: z.string().trim().min(1).max(120).optional(),
  timeOfDay: timeOfDay.optional(),
  timeZone: z.string().trim().min(1).max(64),
});

/** Settings of a machine job (and the part of a member's override that is not a schedule). */
const endpointSettingsShape = {
  paths: z.array(absolutePath).min(1).max(200).optional(),
  excludes: z.array(excludePattern).max(500).optional(),
  /** Skip files larger than this many GiB (shown as GB); null lifts the limit. */
  excludeLargerThanGib: z.number().positive().max(1_000_000).nullable().optional(),
  hooks: z.object({ pre: hookCommand.optional(), post: hookCommand.optional() }).optional(),
  bandwidthKbps: z.number().int().min(1).max(10_000_000).nullable().optional(),
  /** Time windows with a limit of their own; checked for overlap by the service. */
  bandwidthWindows: bandwidthWindowsSchema.optional(),
  retention: retentionSchema.optional(),
};

export const jobSettingsSchema = z.object(endpointSettingsShape);

export const memberOverridesSchema = z.object({
  ...endpointSettingsShape,
  schedule: jobScheduleSchema.optional(),
  verifySchedule: jobScheduleSchema.optional(),
});

/** One member in a request: the id of the protected object (mail jobs) or the machine (machine jobs). */
export const memberInputSchema = z.object({
  id: uuid,
  overrides: memberOverridesSchema.optional(),
});

const jobName = z.string().trim().min(1).max(120);

export const createBackupJobSchema = z.object({
  kind: jobKindSchema,
  name: jobName,
  /** Null or absent: no schedule, the job runs when someone starts it (mail jobs only). */
  schedule: jobScheduleSchema.nullable().optional(),
  /** Mail jobs: the restore-check schedule; null or absent switches the checks off. */
  verifySchedule: jobScheduleSchema.nullable().optional(),
  scope: z
    .object({
      mode: z.enum(["all", "selected"]),
      members: z.array(memberInputSchema).max(5000).default([]),
    })
    .default({ mode: "selected", members: [] }),
  /** The repository; null or absent is the tenant's primary storage target, the only one written to. */
  storageTargetId: uuid.nullable().optional(),
  /** Mail jobs: the snapshot retention policy; null or absent follows the tenant default. */
  retentionPolicyId: uuid.nullable().optional(),
  settings: jobSettingsSchema.default({}),
  enabled: z.boolean().default(true),
  /** Mail jobs: the job's mailboxes are archived through journaling (#32). Machine jobs: always false. */
  archive: z.boolean().default(false),
  /** Take objects and machines that belong to another job instead of refusing them. */
  moveMembers: z.boolean().default(false),
});
export type CreateBackupJobInput = z.infer<typeof createBackupJobSchema>;

export const updateBackupJobSchema = z
  .object({
    name: jobName.optional(),
    schedule: jobScheduleSchema.nullable().optional(),
    verifySchedule: jobScheduleSchema.nullable().optional(),
    storageTargetId: uuid.nullable().optional(),
    retentionPolicyId: uuid.nullable().optional(),
    settings: jobSettingsSchema.optional(),
    enabled: z.boolean().optional(),
    archive: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Nothing to update.",
  });
export type UpdateBackupJobInput = z.infer<typeof updateBackupJobSchema>;

export const replaceMembersSchema = z.object({
  mode: z.enum(["all", "selected"]).optional(),
  members: z.array(memberInputSchema).max(5000),
  move: z.boolean().default(false),
});
export type ReplaceMembersInput = z.infer<typeof replaceMembersSchema>;

export const addMembersSchema = z.object({
  members: z.array(memberInputSchema).min(1).max(5000),
  move: z.boolean().default(false),
});
export type AddMembersInput = z.infer<typeof addMembersSchema>;

export const setOverridesSchema = z.object({ overrides: memberOverridesSchema });
export type SetOverridesInput = z.infer<typeof setOverridesSchema>;

export const runBackupJobSchema = z.object({
  /** The objects or machines to run now; absent runs the whole job. */
  targetIds: z.array(uuid).min(1).max(5000).optional(),
  /** Mail jobs: re-enumerate everything instead of continuing from the delta state. */
  full: z.boolean().default(false),
});
export type RunBackupJobInput = z.infer<typeof runBackupJobSchema>;

export const listBackupJobsQuerySchema = z.object({ kind: jobKindSchema.optional() });
export const defaultsQuerySchema = z.object({ kind: jobKindSchema });
export const candidatesQuerySchema = z.object({
  kind: jobKindSchema,
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const jobParamSchema = z.object({ id: uuid });
export const memberParamSchema = z.object({ id: uuid, targetId: uuid });
