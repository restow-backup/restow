import { z } from "zod";

/** Request schemas for the jobs feature (same style as apps/api/src/schemas.ts). */

export const JOB_QUEUES = [
  "backup",
  "restore",
  "verify",
  "archive",
  "directory",
  "retention",
  "scrub",
  "storage_migration",
  "import",
  "export",
] as const;

export const JOB_STATUSES = ["queued", "active", "completed", "failed", "cancelled"] as const;

export const jobQueueSchema = z.enum(JOB_QUEUES);
export const jobStatusSchema = z.enum(JOB_STATUSES);

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export const listJobsQuerySchema = z.object({
  /** `type` is the integration contract's name for the queue; both are accepted. */
  type: jobQueueSchema.optional(),
  queue: jobQueueSchema.optional(),
  status: jobStatusSchema.optional(),
  /** Only jobs created at or after this instant. */
  since: z.string().datetime({ offset: true }).optional(),
  protectedObjectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  /** Opaque cursor from a previous page's `next`. */
  cursor: z.string().min(1).optional(),
});
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const jobIdParamSchema = z.object({ id: z.string().uuid() });
export const objectIdParamSchema = z.object({ id: z.string().uuid() });

export const startBackupSchema = z.object({
  /** Omit to back up every protected object of the tenant. */
  protectedObjectId: z.string().uuid().optional(),
  /** Re-enumerate everything instead of continuing from delta state. */
  full: z.boolean().default(false),
});
export type StartBackupInput = z.infer<typeof startBackupSchema>;

export const snapshotsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  /** Include pruned snapshots (history) in addition to restorable ones. */
  includePruned: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});
export type SnapshotsQuery = z.infer<typeof snapshotsQuerySchema>;

export const objectsQuerySchema = z.object({
  kind: z.enum(["mailbox", "onedrive", "imap"]).optional(),
});
export type ObjectsQuery = z.infer<typeof objectsQuerySchema>;

/** Query of the tenant-wide event stream. */
export const eventsQuerySchema = z.object({
  /** Only jobs of this queue (the jobs page filters by it). */
  queue: jobQueueSchema.optional(),
});
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
