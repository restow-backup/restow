import { z } from "zod";
import { MAX_SELECTION_ENTRIES, selectionEntrySchema } from "../restore/schemas.js";

/** Request schemas of the mail export API (docs/IMPORT.md). */

/**
 * Every format id the API knows. `pst` is part of the vocabulary so that asking
 * for it answers with the precise `export-format-unavailable` problem instead of
 * a generic validation error; whether an id can be requested is decided by
 * core's `EXPORT_FORMATS` (service.ts).
 */
export const EXPORT_FORMAT_IDS = ["eml_zip", "mbox", "msg_zip", "pst"] as const;
export const exportFormatSchema = z.enum(EXPORT_FORMAT_IDS);
export type ExportFormatInput = z.infer<typeof exportFormatSchema>;

/** The most archive item ids one export request may name. */
export const MAX_ARCHIVE_EXPORT_ITEM_IDS = 10_000;

/** File name the person wants for the download; the worker reduces it to a storage-safe name. */
export const exportFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^/\\\p{Cc}]+$/u, "must not contain slashes or control characters");

/** Required when an admin exports another person's data (impersonation). */
const exportReasonSchema = z.string().trim().min(3).max(2000);

/** A date given as an ISO 8601 string; null and "" mean "not given" (coerce would turn null into 1970). */
const optionalDateSchema = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z.coerce.date().optional(),
);

/**
 * The archive search query as an export selection (GET /archive/search takes
 * the same fields as query parameters). Dates are ISO 8601 strings.
 */
export const archiveExportFilterSchema = z
  .object({
    q: z.string().trim().max(500).optional(),
    mailbox: z.string().uuid().optional(),
    from: z.string().trim().max(320).optional(),
    dateFrom: optionalDateSchema,
    dateTo: optionalDateSchema,
    hasAttachment: z.boolean().optional(),
  })
  .strict()
  .refine((filter) => !filter.dateFrom || !filter.dateTo || filter.dateFrom <= filter.dateTo, {
    message: "dateFrom must not be after dateTo",
    path: ["dateFrom"],
  });
export type ArchiveExportFilter = z.infer<typeof archiveExportFilterSchema>;

/** An archive selection is either explicit item ids or a search filter, never both. */
export const archiveExportSelectionSchema = z.union([
  z
    .object({
      itemIds: z.array(z.string().uuid()).min(1).max(MAX_ARCHIVE_EXPORT_ITEM_IDS),
    })
    .strict(),
  z.object({ filter: archiveExportFilterSchema }).strict(),
]);
export type ArchiveExportSelection = z.infer<typeof archiveExportSelectionSchema>;

export const snapshotExportSchema = z.object({
  origin: z.literal("snapshot"),
  snapshotId: z.string().uuid(),
  selection: z.array(selectionEntrySchema).min(1).max(MAX_SELECTION_ENTRIES),
  format: exportFormatSchema,
  reason: exportReasonSchema.optional(),
  fileName: exportFileNameSchema.optional(),
});

export const archiveExportSchema = z.object({
  origin: z.literal("archive"),
  selection: archiveExportSelectionSchema,
  format: exportFormatSchema,
  reason: exportReasonSchema.optional(),
  fileName: exportFileNameSchema.optional(),
});

export const createExportSchema = z.discriminatedUnion("origin", [
  snapshotExportSchema,
  archiveExportSchema,
]);
export type CreateExportInput = z.infer<typeof createExportSchema>;
export type SnapshotExportInput = z.infer<typeof snapshotExportSchema>;
export type ArchiveExportInput = z.infer<typeof archiveExportSchema>;

export const exportIdParamSchema = z.object({ id: z.string().uuid() });

export const listExportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  /** Rows to skip, newest first: the next page of older exports. */
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
/** The parsed query; `offset` may be left out by direct callers (the first page). */
export type ListExportsQuery = Omit<z.infer<typeof listExportsQuerySchema>, "offset"> & {
  offset?: number;
};

/**
 * The filter as it is stored in `mail_exports.selection`: only the fields that
 * were given, dates as ISO strings (jsonb has no date type), empty strings
 * dropped. The worker turns it back into the archive search conditions.
 */
export interface StoredArchiveFilter {
  q?: string;
  mailbox?: string;
  from?: string;
  dateFrom?: string;
  dateTo?: string;
  hasAttachment?: boolean;
}

export function toStoredArchiveFilter(filter: ArchiveExportFilter): StoredArchiveFilter {
  const stored: StoredArchiveFilter = {};
  if (filter.q) stored.q = filter.q;
  if (filter.mailbox) stored.mailbox = filter.mailbox;
  if (filter.from) stored.from = filter.from;
  if (filter.dateFrom) stored.dateFrom = filter.dateFrom.toISOString();
  if (filter.dateTo) stored.dateTo = filter.dateTo.toISOString();
  if (filter.hasAttachment !== undefined) stored.hasAttachment = filter.hasAttachment;
  return stored;
}
