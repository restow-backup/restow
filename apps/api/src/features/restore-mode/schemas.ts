import { z } from "zod";
import { END_CONFIRMATION, MAX_CHECKED_LENGTH, MIN_CHECKED_LENGTH } from "./service.js";

/**
 * Request documents of the Restore mode page (routes.ts). Responses are the service's own
 * types (service.ts).
 */

export const startRestoreModeInputSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const importRestoreModeKeysInputSchema = z
  .object({
    tenantId: z.string().uuid().optional(),
  })
  .strict();

export const endRestoreModeInputSchema = z
  .object({
    checked: z.string().trim().min(MIN_CHECKED_LENGTH).max(MAX_CHECKED_LENGTH),
    confirmation: z.literal(END_CONFIRMATION),
    storageOnlyData: z.enum(["keep", "release"]),
    acceptUnreachable: z.array(z.string().min(1).max(200)).max(500).optional(),
  })
  .strict();
