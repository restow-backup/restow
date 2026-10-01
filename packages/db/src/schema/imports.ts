import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { snapshots } from "./backup.js";
import { jobs } from "./jobs.js";
import { protectedObjects, sources } from "./sources.js";
import { tenants } from "./tenants.js";

/**
 * Mail file import and export (docs/IMPORT.md).
 *
 * An import brings mail files (EML, MSG, MBOX, ZIP archives, folder trees such
 * as MailStore exports) into an "imported mailbox": a protected object of kind
 * `imap` under a source of kind `import`, whose snapshots use the same
 * manifest format as an IMAP backup. The files arrive either as chunked
 * uploads into an encrypted staging area (`import_uploads`) or from the
 * server-side import folder. An export turns backed-up, imported or archived
 * mail into an EML ZIP or an MBOX file that lies encrypted in the tenant's
 * storage until it expires.
 */

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/**
 * `uploading` = segments still arriving, `ready` = complete and format checked,
 * `consumed` = an import took it over, `cancelled` = withdrawn by the person,
 * `expired` = never used (the staged segments are deleted).
 */
export const importUploadStatusEnum = pgEnum("import_upload_status", [
  "uploading",
  "ready",
  "consumed",
  "cancelled",
  "expired",
]);

/**
 * A file being uploaded for an import, staged as sealed segments in the
 * tenant's primary storage (tenants/<tid>/staging/<id>/), one segment per
 * client chunk. Resumable: the client asks which segments exist and sends the
 * rest. The staged segments are deleted once the import used the file, when the
 * upload is cancelled and when it expires.
 */
export const importUploads = pgTable(
  "import_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // The name the browser reported. Display only: never trusted for the type.
    fileName: text("file_name").notNull(),
    // Declared size of the whole file in bytes.
    size: bigint("size", { mode: "number" }).notNull(),
    // Plaintext bytes of every segment except the last.
    segmentSize: integer("segment_size").notNull(),
    segmentCount: integer("segment_count").notNull(),
    status: importUploadStatusEnum("status").notNull().default("uploading"),
    // What the bytes turned out to be (MailFileFormat), set when the upload completes.
    detectedFormat: text("detected_format"),
    // The import that took the file over (soft link, like jobs.job_id elsewhere).
    importId: uuid("import_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    index("import_uploads_tenant_status_idx").on(t.tenantId, t.status),
    index("import_uploads_expires_idx").on(t.expiresAt),
  ],
);

/** One received segment of an upload (its size and SHA-256), so a resume knows what is there. */
export const importUploadSegments = pgTable(
  "import_upload_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => importUploads.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    segmentIndex: integer("segment_index").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("import_upload_segments_uq").on(t.uploadId, t.segmentIndex)],
);

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** One file an import was asked to read. */
export type MailImportRequestFile = {
  // "upload" = staged upload (uploadId), "folder" = file or directory of the server-side import folder.
  origin: "upload" | "folder";
  uploadId?: string;
  // A directory (folder origin only) is read as a whole tree, e.g. a MailStore export.
  kind: "file" | "directory";
  // Display path; for a folder entry the path relative to the import folder.
  path: string;
  // Bytes; 0 for a directory (the worker adds up what it finds).
  size: number;
  // The format detected when the file was chosen (MailFileFormat), null if unknown yet.
  format: string | null;
};

export type MailImportOptions = {
  // Also ingest every imported message into the archive (retention and search apply).
  archive: boolean;
};

/**
 * One import run: the request (files, options) and, once the job finished, its
 * report. Progress lives in job_progress and the unreadable items in
 * item_failures under `job_id`, like every job. Deleting the imported mailbox
 * deletes the record.
 */
export const mailImports = pgTable(
  "mail_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    // Display name of the imported mailbox when the import was requested.
    name: text("name").notNull(),
    files: jsonb("files").$type<MailImportRequestFile[]>().notNull(),
    options: jsonb("options").$type<MailImportOptions>().notNull(),
    // The ImportReport of @restow/core (mailfiles/types.ts), written when the job finishes.
    report: jsonb("report").$type<Record<string, unknown>>(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("mail_imports_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Where the exported mail comes from: a backup or import snapshot, or the archive. */
export const exportOriginEnum = pgEnum("export_origin", ["snapshot", "archive"]);

/**
 * `eml_zip` = one .eml per message in a ZIP with the folder structure and
 * checksum lists, `mbox` = MBOX (one file per folder inside a ZIP, or a single
 * .mbox for one folder), `msg_zip` = one .msg per message in a ZIP.
 */
export const exportFormatEnum = pgEnum("export_format", ["eml_zip", "mbox", "msg_zip"]);

/**
 * An export request and its result. The finished file lies in the tenant's
 * storage as sealed segments (tenants/<tid>/exports/<id>/) until `expires_at`,
 * then the file is deleted (`purged_at`). Every request and every download is
 * audited.
 */
export const mailExports = pgTable(
  "mail_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    origin: exportOriginEnum("origin").notNull(),
    format: exportFormatEnum("format").notNull(),
    // origin snapshot: the snapshot and the protected object it belongs to.
    snapshotId: uuid("snapshot_id").references(() => snapshots.id, { onDelete: "set null" }),
    protectedObjectId: uuid("protected_object_id").references(() => protectedObjects.id, {
      onDelete: "set null",
    }),
    // snapshot: { paths?, folderPaths?, all? }; archive: { itemIds? } or { filter } (the search query).
    selection: jsonb("selection").$type<Record<string, unknown>>().notNull(),
    // Set when the job finished.
    fileName: text("file_name"),
    contentType: text("content_type"),
    fileSize: bigint("file_size", { mode: "number" }),
    segmentSize: integer("segment_size"),
    sha256: text("sha256"),
    // Counts and the messages that could not be exported (capped), written by the job.
    report: jsonb("report").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    impersonated: boolean("impersonated").notNull().default(false),
    reason: text("reason"),
    ...timestamps(),
  },
  (t) => [
    index("mail_exports_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("mail_exports_expires_idx").on(t.expiresAt),
  ],
);

export type ImportUpload = typeof importUploads.$inferSelect;
export type NewImportUpload = typeof importUploads.$inferInsert;
export type ImportUploadSegment = typeof importUploadSegments.$inferSelect;
export type MailImport = typeof mailImports.$inferSelect;
export type NewMailImport = typeof mailImports.$inferInsert;
export type MailExport = typeof mailExports.$inferSelect;
export type NewMailExport = typeof mailExports.$inferInsert;
export type ImportUploadStatus = (typeof importUploadStatusEnum.enumValues)[number];
export type ExportOrigin = (typeof exportOriginEnum.enumValues)[number];
export type ExportFormat = (typeof exportFormatEnum.enumValues)[number];
