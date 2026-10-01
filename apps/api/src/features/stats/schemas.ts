import { z } from "zod";
import { DATASET_NAMES } from "./dto.js";
import { GRANULARITIES } from "./period.js";

/**
 * Query schemas of the statistics routes (same style as apps/api/src/schemas.ts).
 * Days are validated as real calendar days by period.ts, which also fills in
 * the defaults (the last 30 days, a granularity that fits the length).
 */

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a day in the form YYYY-MM-DD.")
  .optional();

export const statsQuerySchema = z.object({
  from: day,
  to: day,
  granularity: z.enum(GRANULARITIES).optional(),
  /** `provider` adds up every tenant (provider admins, while `stats.allTenants` is on). */
  scope: z.enum(["tenant", "provider"]).default("tenant"),
});
export type StatsQuery = z.infer<typeof statsQuerySchema>;

export const exportQuerySchema = statsQuerySchema.extend({
  dataset: z.enum(DATASET_NAMES),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const reportQuerySchema = statsQuerySchema.extend({
  /** Report language; the requester's Accept-Language when omitted. */
  lang: z.enum(["de", "en"]).optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;
