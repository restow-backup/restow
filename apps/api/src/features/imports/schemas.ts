import { z } from "zod";

/** Request schemas of the mail file import (same style as apps/api/src/schemas.ts). */

/** Most entries one import request may carry (uploads plus folder entries). */
export const MAX_IMPORT_ENTRIES = 500;
/** Longest file name accepted for an upload (bytes of the display name). */
export const MAX_UPLOAD_FILE_NAME = 255;
/** Longest import folder path accepted. */
export const MAX_FOLDER_PATH = 4096;

/**
 * The name the browser reported. Display only (the format is judged by the
 * bytes), so the rules are about keeping it harmless in the UI, the audit log
 * and the report: no path separators and no control characters.
 */
export const uploadFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_UPLOAD_FILE_NAME)
  .refine((name) => !/[\\/\p{Cc}]/u.test(name), "must not contain slashes or control characters");

export const createUploadSchema = z.object({
  fileName: uploadFileNameSchema,
  /** Bytes of the whole file. The upper limit (IMPORT_MAX_FILE_BYTES) is a 413, not a validation error. */
  size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** Proposed plaintext bytes per segment; the server clamps it to what it supports. */
  segmentSize: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type CreateUploadInput = z.infer<typeof createUploadSchema>;

export const uploadIdParamSchema = z.object({ id: z.string().uuid() });

export const segmentParamsSchema = z.object({
  id: z.string().uuid(),
  index: z.coerce.number().int().min(0).max(99_999_999),
});

/** `X-Segment-Sha256`: 64 hex digits (either case). */
export const segmentSha256Schema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hexadecimal digits");

export const folderQuerySchema = z.object({
  path: z.string().max(MAX_FOLDER_PATH).default(""),
});
export type FolderQuery = z.infer<typeof folderQuerySchema>;

const importFileSchema = z.discriminatedUnion("origin", [
  z.object({ origin: z.literal("upload"), uploadId: z.string().uuid() }),
  z.object({
    origin: z.literal("folder"),
    /** Relative to the import folder; the empty path is the folder itself. */
    path: z.string().max(MAX_FOLDER_PATH),
  }),
]);
export type ImportFileInput = z.infer<typeof importFileSchema>;

/** Same entry twice: the same upload, or the same folder path (ignoring slashes and "." parts). */
export function normalizeFolderPath(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

function entryKey(file: ImportFileInput): string {
  return file.origin === "upload"
    ? `upload:${file.uploadId.toLowerCase()}`
    : `folder:${normalizeFolderPath(file.path)}`;
}

export const createImportSchema = z
  .object({
    /** A new imported mailbox. Exactly one of `name` and `objectId`. */
    name: z.string().trim().min(1).max(120).optional(),
    /** An existing imported mailbox of this tenant to add the files to. */
    objectId: z.string().uuid().optional(),
    files: z.array(importFileSchema).min(1).max(MAX_IMPORT_ENTRIES),
    /** Also ingest every imported message into the archive. */
    archive: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if ((value.name === undefined) === (value.objectId === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Give exactly one of name (a new imported mailbox) and objectId (an existing one).",
        path: ["name"],
      });
    }
    const seen = new Set<string>();
    value.files.forEach((file, index) => {
      const key = entryKey(file);
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "This entry is listed more than once.",
          path: ["files", index],
        });
      }
      seen.add(key);
    });
  });
export type CreateImportInput = z.infer<typeof createImportSchema>;

export const importIdParamSchema = z.object({ id: z.string().uuid() });

export const listImportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export type ListImportsQuery = z.infer<typeof listImportsQuerySchema>;
