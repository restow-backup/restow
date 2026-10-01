import { z } from "zod";

/** Request schemas for the snapshot explorer (same style as apps/api/src/schemas.ts). */

/**
 * A logical path inside a source ("Inbox/Projects", "Documents/report.docx").
 * Leading and trailing slashes are tolerated and stripped; "" is the root.
 */
export const objectPathSchema = z
  .string()
  .max(4096)
  .transform((value) => value.replace(/^\/+|\/+$/g, ""));

const booleanFlag = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true");

export const uuidParamSchema = z.object({ id: z.string().uuid() });

export const snapshotEntryParamSchema = z.object({
  snapshotId: z.string().uuid(),
  entryId: z.string().uuid(),
});

/** `att-<index>`: the attachment's position within the message, stable for one snapshot. */
export const attachmentParamSchema = snapshotEntryParamSchema.extend({
  attachmentId: z.string().regex(/^att-\d+$/, "not an attachment id"),
});

export const listSnapshotsQuerySchema = z.object({
  objectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListSnapshotsQuery = z.infer<typeof listSnapshotsQuerySchema>;

/** `withBackup` (default): only objects with a completed snapshot. `all`: every visible object. */
export const listObjectsQuerySchema = z.object({
  include: z.enum(["withBackup", "all"]).default("withBackup"),
});
export type ListObjectsQuery = z.infer<typeof listObjectsQuerySchema>;

export const treeQuerySchema = z.object({
  path: objectPathSchema.default(""),
  /** Include objects the source had deleted by the time of the snapshot. */
  includeDeleted: booleanFlag(true),
  /** Only folders (the explorer's folder tree). */
  foldersOnly: booleanFlag(false),
  /** Mail sorts by date (default) or name; folders are always first, files always by name. */
  sort: z.enum(["date", "name"]).default("date"),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TreeQuery = z.infer<typeof treeQuerySchema>;

export const versionsQuerySchema = z.object({
  path: objectPathSchema.refine((path) => path.length > 0, "path must name an item"),
  /** Also match the source item id, so a renamed or moved item keeps its history. */
  itemId: z.string().min(1).max(1024).optional(),
  /** Also list the versions the source itself kept, as captured in this snapshot. */
  snapshotId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type VersionsQuery = z.infer<typeof versionsQuerySchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  /** Restrict to one protected object (otherwise every visible object is searched). */
  objectId: z.string().uuid().optional(),
  /** Search this snapshot instead of the latest snapshot of each object. */
  snapshotId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
