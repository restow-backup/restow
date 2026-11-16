import { z } from "zod";
import { restoreReportSchema } from "./restore-report.js";

/**
 * The updater's side of a restore from a database dump in the setup wizard (restore.ts,
 * docs/DATABASE.md "Restore an installation from a dump"): the uploads of a dump in parts, and
 * the restore itself. The api relays the wizard's calls (routes/setup-restore.ts), behind the
 * setup token.
 */

/** One part of an upload; the last one may be shorter. */
export const UPLOAD_PART_BYTES = 32 * 1024 * 1024;
/** The largest dump the wizard uploads (larger ones go through install.sh --restore). */
export const MAX_UPLOAD_BYTES = 512 * 1024 ** 3;

export const uploadStartSchema = z
  .object({
    bytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    /** SHA-256 of the whole file (hex), checked when the upload completes. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type UploadStart = z.infer<typeof uploadStartSchema>;

export const UPLOAD_ID = /^[0-9a-f]{32}$/;

export const uploadViewSchema = z.object({
  id: z.string(),
  bytes: z.number().int(),
  received: z.number().int(),
});
export type UploadView = z.infer<typeof uploadViewSchema>;

export const restoreActorSchema = z
  .object({ userId: z.string().nullable(), label: z.string().max(200), ip: z.string().nullable() })
  .strict();

export const restoreStartSchema = z
  .object({ dump: z.string().min(1).max(200), requestedBy: restoreActorSchema })
  .strict();
export type RestoreStart = z.infer<typeof restoreStartSchema>;

export const restoreActivateSchema = z
  .object({
    /** The operator saw unreachable targets in the report and goes ahead all the same. */
    acceptUnreachable: z.boolean().default(false),
    requestedBy: restoreActorSchema,
  })
  .strict();

export const restoreAbortSchema = z.object({ requestedBy: restoreActorSchema }).strict();

/**
 *   restoring              worker and scheduler stopped, the dump goes into the scratch database
 *   preparing              `restow restore prepare` on it
 *   awaiting_confirmation  the report is there; the operator activates or aborts
 *   activating             api stopped, `restow restore activate`, api started
 *   starting               worker and scheduler started on the restored database
 */
export const RESTORE_PHASES = [
  "restoring",
  "preparing",
  "awaiting_confirmation",
  "activating",
  "starting",
] as const;

/**
 *   done             the restored database is live, restore mode on
 *   refused          prepare refused the dump (wrong master key, newer release, ...): the scratch
 *                    database was dropped, the fresh installation runs as before
 *   failed           a step failed before activation; same as refused
 *   aborted          the operator aborted at the confirmation
 *   needs_attention  a step failed during or after activation, or the updater restarted in the
 *                    middle: worker and scheduler stay stopped (docs/DATABASE.md)
 */
export const RESTORE_STATUSES = [
  "running",
  "awaiting_confirmation",
  "done",
  "refused",
  "failed",
  "aborted",
  "needs_attention",
] as const;

export const restoreRecordSchema = z.object({
  id: z.string(),
  status: z.enum(RESTORE_STATUSES),
  phase: z.enum(RESTORE_PHASES),
  dump: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  report: restoreReportSchema.nullable(),
  /** Why it failed or needs attention (redacted, one line). */
  message: z.string().nullable(),
  requestedBy: restoreActorSchema,
  /** Worker and scheduler were stopped by this restore (they start again only after it). */
  servicesStopped: z.boolean(),
});
export type RestoreRecord = z.infer<typeof restoreRecordSchema>;
