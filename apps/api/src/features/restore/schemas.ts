import { z } from "zod";
import { objectPathSchema } from "../snapshots/schemas.js";

/** Request schemas for restore requests (same style as apps/api/src/schemas.ts). */

/**
 * "replace" is refused for every target that writes into an account
 * (service.ts, createRestore: urn:restow:problem:restore-replace-not-allowed):
 * a restore never replaces what is there (docs/ARCHITECTURE.md, Restore).
 * Replacing OneDrive files (the existing file becoming an earlier version) is
 * planned for a later release. The value stays in the schema (and the
 * `restore_mode` database enum) so a request or a stored job from before that
 * change still parses.
 */
export const restoreModeSchema = z.enum(["rename", "replace", "skip"]);
export type RestoreModeInput = z.infer<typeof restoreModeSchema>;

/**
 * One explorer selection entry: a path (folder or item) or a source item id.
 * The root path ("" or "/") selects the whole snapshot.
 */
export const selectionEntrySchema = z.union([
  z.object({
    path: objectPathSchema,
    /** Hint from the explorer; the server verifies it against the snapshot. */
    kind: z.enum(["folder", "item"]).optional(),
  }),
  z.object({ itemId: z.string().min(1).max(1024) }),
]);
export type SelectionEntry = z.infer<typeof selectionEntrySchema>;

export const restoreTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("original") }),
  z.object({
    type: z.literal("other"),
    /** Target mailbox address / drive id or UPN (optionally `:/<folder>`) / IMAP login. */
    accountId: z.string().trim().min(1).max(512),
  }),
  z.object({ type: z.literal("download") }),
]);
export type RestoreTargetInput = z.infer<typeof restoreTargetSchema>;

/**
 * Whether a restore request's mode is allowed for the target it writes to.
 * "replace" is refused for every account target (a restore never replaces
 * what is there, docs/ARCHITECTURE.md, Restore). Mode governs collisions
 * inside the target account, so it has no effect on a "download" target (a
 * ZIP archive, not an account); a stray "replace" is let through there rather
 * than refused.
 *
 * Pure so it is covered by a unit test independent of the database
 * (service.ts's createRestore, used by both the session API and the v1 API,
 * throws the 422 `urn:restow:problem:restore-replace-not-allowed` when this
 * returns false).
 */
export function isReplaceModeAllowedFor(
  mode: RestoreModeInput,
  targetType: RestoreTargetInput["type"],
): boolean {
  return mode !== "replace" || targetType === "download";
}

/**
 * The mode a restore request is stored and audited with: "replace" is let
 * through for a download target because mode has no effect on a ZIP archive
 * (isReplaceModeAllowedFor), but storing it as "replace" would read, in
 * `restore_jobs` history and the audit log, as if the restore once replaced
 * something — it never did.
 */
export function normalizeStoredRestoreMode(
  mode: RestoreModeInput,
  targetType: RestoreTargetInput["type"],
): RestoreModeInput {
  return mode === "replace" && targetType === "download" ? "rename" : mode;
}

/**
 * Presentation choices the engines honour (packages/core restore/common.ts,
 * RestoreRequestOptions). The explorer sends them in the user's language.
 */
export const restoreOptionsSchema = z.object({
  /** Folder that "keep both" restores of mail, calendar and contacts land in. */
  restoreFolderName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^/\\\p{Cc}]+$/u, "must not contain slashes or control characters")
    .optional(),
  /** File name of a download archive; reduced to a storage-safe name by the engine. */
  archiveName: z.string().trim().min(1).max(120).optional(),
});
export type RestoreOptionsInput = z.infer<typeof restoreOptionsSchema>;

/**
 * The kind of account an imported mailbox is restored into (docs/IMPORT.md):
 * a Microsoft 365 mailbox goes through the Exchange restore engine, an IMAP
 * account through IMAP append. The worker routes on it. The server decides it
 * from the target account; a request cannot set it (the options schema drops
 * unknown keys).
 */
export type RestoreTargetKind = "mailbox" | "imap";

/**
 * The kind of a target account that is both an M365 mailbox and an IMAP
 * account of the tenant: the mailbox wins, because the Exchange engine keeps
 * more of the message. Null when it is neither.
 */
export function pickRestoreTargetKind(found: {
  mailbox: boolean;
  imap: boolean;
}): RestoreTargetKind | null {
  return found.mailbox ? "mailbox" : found.imap ? "imap" : null;
}

/**
 * The options stored in `restore_jobs.source_selection.options`: the request's
 * own presentation choices plus, for an imported mailbox restored into an
 * account, the target kind. Undefined when there is nothing to store.
 */
export function storedRestoreOptions(
  options: RestoreOptionsInput | undefined,
  targetKind: RestoreTargetKind | null,
): (RestoreOptionsInput & { targetKind?: RestoreTargetKind }) | undefined {
  if (!options && !targetKind) {
    return undefined;
  }
  return { ...options, ...(targetKind ? { targetKind } : {}) };
}

export const MAX_SELECTION_ENTRIES = 5000;

export const createRestoreSchema = z.object({
  snapshotId: z.string().uuid(),
  selection: z.array(selectionEntrySchema).min(1).max(MAX_SELECTION_ENTRIES),
  target: restoreTargetSchema,
  mode: restoreModeSchema.default("rename"),
  /** Required when an admin restores another person's data (impersonation). */
  reason: z.string().trim().min(3).max(2000).optional(),
  options: restoreOptionsSchema.optional(),
});
export type CreateRestoreInput = z.infer<typeof createRestoreSchema>;

export const restoreIdParamSchema = z.object({ id: z.string().uuid() });

export const listRestoresQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Rows to skip, newest first: the next page of older restores. */
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  objectId: z.string().uuid().optional(),
});
/** The parsed query; `offset` may be left out by direct callers (the first page). */
export type ListRestoresQuery = Omit<z.infer<typeof listRestoresQuerySchema>, "offset"> & {
  offset?: number;
};

export const restoreTargetsQuerySchema = z.object({
  objectId: z.string().uuid(),
});
export type RestoreTargetsQuery = z.infer<typeof restoreTargetsQuerySchema>;
