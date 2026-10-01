import { z } from "zod";

/** GET /archive/search query (docs/ARCHIVE.md, Volltextsuche). */
export const archiveSearchQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  mailbox: z.string().uuid().optional(),
  from: z.string().trim().max(320).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  hasAttachment: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
export type ArchiveSearchQuery = z.infer<typeof archiveSearchQuerySchema>;

export const archiveItemParamSchema = z.object({ id: z.string().uuid() });

export const chainVerifyQuerySchema = z.object({
  tenant: z.string().uuid().optional(),
});
