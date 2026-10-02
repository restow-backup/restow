import { z } from "zod";
import { RUN_CATEGORIES } from "./dto.js";

/** Request schemas of the history feature. */

export const HISTORY_PAGE_SIZE = 50;
export const HISTORY_MAX_PAGE_SIZE = 200;

export const historyQuerySchema = z.object({
  /** The History tab: one kind of run. Absent lists every run. */
  type: z.enum(RUN_CATEGORIES).optional(),
  /** Only the runs of this backup job. */
  job: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_MAX_PAGE_SIZE).default(HISTORY_PAGE_SIZE),
  /** Opaque cursor from a previous page's `next`. */
  cursor: z.string().min(1).optional(),
});
export type HistoryQueryInput = z.infer<typeof historyQuerySchema>;

export const runIdParamSchema = z.object({ id: z.string().uuid() });
