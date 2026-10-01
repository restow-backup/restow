import { z } from "zod";

/** Request schemas for recovery readiness (same style as apps/api/src/schemas.ts). */

export const verifyKindSchema = z.enum(["verify", "health_check"]);
export type VerifyKindInput = z.infer<typeof verifyKindSchema>;

/** Upper bound the worker accepts for a per-category sample (apps/worker handlers/verify.ts). */
export const MAX_SAMPLE_SIZE = 200;

export const runVerifySchema = z.object({
  /** Omit to check every protected object that has a backup. */
  protectedObjectId: z.string().uuid().optional(),
  /** `verify` reads a random sample back; `health_check` reads every object. */
  kind: verifyKindSchema.default("verify"),
  /** Objects per category for a `verify` run; the worker default (20) when omitted. */
  sampleSize: z.number().int().min(1).max(MAX_SAMPLE_SIZE).optional(),
  /**
   * Without `protectedObjectId`: check only the objects whose newest backup is
   * not verified yet, instead of every object.
   */
  unverifiedOnly: z.boolean().optional(),
});
export type RunVerifyInput = z.infer<typeof runVerifySchema>;

export const runScrubSchema = z.object({
  /** `sample` checks a share of the packs, `full` every pack and collects garbage. */
  mode: z.enum(["sample", "full"]).default("sample"),
});
export type RunScrubInput = z.infer<typeof runScrubSchema>;

export const listReportsQuerySchema = z.object({
  objectId: z.string().uuid().optional(),
  readiness: z.enum(["green", "yellow", "red"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque cursor from the previous page's `next`. */
  cursor: z.string().max(512).optional(),
});
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;

export const reportIdParamSchema = z.object({ id: z.string().uuid() });
