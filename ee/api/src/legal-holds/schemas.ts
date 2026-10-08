import { z } from "zod";

/** POST /archive/legal-holds body (docs/ARCHIVE.md, Legal Hold). */
export const createLegalHoldSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    protectedObjectId: z.string().uuid().nullable().optional(),
    scope: z.record(z.unknown()).nullable().optional(),
  })
  .strict();
export type CreateLegalHoldInput = z.infer<typeof createLegalHoldSchema>;

export const legalHoldParamSchema = z.object({ id: z.string().uuid() });

/**
 * DELETE /archive/legal-holds/:id body: why the hold is released. Optional for
 * API clients of the first version (no body); the web interface always asks.
 */
export const releaseLegalHoldSchema = z
  .object({ reason: z.string().trim().min(1).max(2000).optional() })
  .strict();
export type ReleaseLegalHoldInput = z.infer<typeof releaseLegalHoldSchema>;
