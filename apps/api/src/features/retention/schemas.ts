import {
  RETENTION_PRESETS,
  type RetentionPreset,
  type RetentionTier,
  presetTiers,
  validateTiers,
} from "@restow/core";
import { z } from "zod";
import { ProblemError } from "../../problem.js";

/**
 * Request schemas of the retention feature (same style as apps/api/src/schemas.ts).
 * Shapes are checked here; whether a policy can run (a usable, contiguous
 * tier list) is decided by the shared @restow/core code, and every refusal is
 * a 422 problem naming the field to correct.
 */

export const INVALID_RETENTION_POLICY_PROBLEM = "urn:restow:problem:invalid-retention-policy";

export type RetentionPolicyField = "name" | "preset" | "tiers" | "protectedObjectIds";

export function retentionPolicyProblem(
  field: RetentionPolicyField,
  code: string,
  message: string,
): ProblemError {
  return new ProblemError(422, "Invalid retention policy", {
    type: INVALID_RETENTION_POLICY_PROBLEM,
    detail: `${field}: ${message}`,
    extensions: { field, code, issues: [{ path: [field], code, message }] },
  });
}

const tierSchema = z
  .object({
    fromDays: z.number().int().min(0),
    toDays: z.number().int().positive().nullable(),
    keepEveryDays: z.number().int().min(0),
  })
  .strict();

const nameField = z.string().trim().min(1).max(200);
const presetField = z.enum(RETENTION_PRESETS);
/** null = the tenant-wide default; a non-empty list scopes the policy to those objects. */
const objectIdsField = z.array(z.string().uuid()).min(1).max(500).nullable();

export const createRetentionPolicySchema = z
  .object({
    name: nameField,
    preset: presetField,
    /** Required (and only read) for preset "custom". */
    tiers: z.array(tierSchema).optional(),
    protectedObjectIds: objectIdsField.optional().transform((value) => value ?? null),
  })
  .strict();
export type CreateRetentionPolicyInput = z.infer<typeof createRetentionPolicySchema>;

export const updateRetentionPolicySchema = z
  .object({
    name: nameField.optional(),
    preset: presetField.optional(),
    tiers: z.array(tierSchema).optional(),
    protectedObjectIds: objectIdsField.optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Nothing to update.",
  });
export type UpdateRetentionPolicyInput = z.infer<typeof updateRetentionPolicySchema>;

export const previewRetentionPolicySchema = z
  .object({
    /** Preview as a change to this existing policy; omitted previews a new one. */
    id: z.string().uuid().optional(),
    preset: presetField,
    tiers: z.array(tierSchema).optional(),
    protectedObjectIds: objectIdsField.optional().transform((value) => value ?? null),
  })
  .strict();
export type PreviewRetentionPolicyInput = z.infer<typeof previewRetentionPolicySchema>;

export const retentionPolicyParamSchema = z.object({ id: z.string().uuid() });

/**
 * The tiers a preset resolves to: the built-in ones, or a custom list, which
 * must be a usable, contiguous tier list starting at day 0 ({@link validateTiers}).
 */
export function resolveTiers(
  preset: RetentionPreset,
  tiers: readonly RetentionTier[] | undefined,
): RetentionTier[] {
  if (preset !== "custom") {
    return [...presetTiers(preset)];
  }
  if (!tiers || tiers.length === 0) {
    throw retentionPolicyProblem("tiers", "required", "A custom policy needs at least one tier.");
  }
  const issue = validateTiers(tiers);
  if (issue) {
    throw retentionPolicyProblem("tiers", issue.code, issue.message);
  }
  return [...tiers];
}
