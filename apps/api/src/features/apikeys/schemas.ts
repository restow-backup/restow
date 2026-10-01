import { z } from "zod";
import { API_SCOPES } from "./scopes.js";

/** Request schemas of the API keys feature (same style as apps/api/src/schemas.ts). */

/** The longest lifetime a key can be created with (five years). */
export const MAX_KEY_LIFETIME_DAYS = 1825;

export const apiScopeSchema = z.enum(API_SCOPES);

export const createApiKeySchema = z.object({
  /** What the key is for, e.g. "RMM" or "Ticket system". */
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(apiScopeSchema)
    .min(1)
    .max(API_SCOPES.length)
    .transform((scopes) => [...new Set(scopes)]),
  /** Days until the key stops working; null or omitted for no expiry. */
  expiresInDays: z.number().int().min(1).max(MAX_KEY_LIFETIME_DAYS).nullable().default(null),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const apiKeyParamSchema = z.object({ id: z.string().uuid() });
