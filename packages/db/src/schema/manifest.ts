import {
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdOnly } from "./_shared.js";
import { snapshots } from "./backup.js";
import { protectedObjects } from "./sources.js";
import { tenants } from "./tenants.js";

/** What a manifest entry represents. `folder` rows carry no chunks. */
export const manifestObjectKindEnum = pgEnum("manifest_object_kind", [
  "mail",
  "folder",
  "file",
  "event",
  "contact",
]);

/**
 * Searchable per-snapshot index mirrored from the snapshot manifest in object
 * storage (the manifest stays the truth for the standalone restore, see
 * docs/ARCHITECTURE.md). One row per object per snapshot, so browsing a
 * snapshot is a lookup on (snapshot_id, parent_path) and version history of a
 * file is a lookup on (protected_object_id, item_id) across snapshots.
 *
 * `path` is the logical path within the source ("Inbox/Projects", "Documents/
 * report.docx"); `parentPath` is its directory ("" for the root). `deleted`
 * marks an object the source removed since the previous snapshot, kept so the
 * explorer can show and restore it. Rows are immutable (pruning a snapshot
 * cascades them away), hence `created_at` only.
 */
export const manifestObjects = pgTable(
  "manifest_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    kind: manifestObjectKindEnum("kind").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    parentPath: text("parent_path").notNull().default(""),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mtime: timestamp("mtime", { withTimezone: true }),
    // Stable source item id (Graph message/driveItem/event/contact id, IMAP UID).
    itemId: text("item_id"),
    // RFC 5322 Message-ID for mail items (dedupe and restore matching).
    messageId: text("message_id"),
    // Ordered stored chunk ids (hex) that reconstruct the object; null for folders.
    chunkRefs: jsonb("chunk_refs").$type<string[]>(),
    // Source metadata (etag, content type, subject, from, attendees, ...).
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    deleted: boolean("deleted").notNull().default(false),
    ...createdOnly(),
  },
  (t) => [
    index("manifest_objects_snapshot_parent_idx").on(t.snapshotId, t.parentPath),
    index("manifest_objects_tenant_path_idx").on(t.tenantId, t.path),
    index("manifest_objects_object_item_idx").on(t.protectedObjectId, t.itemId),
  ],
);

// Named *Row to stay distinct from @restow/core's ManifestObject (the manifest
// file entry) when both are imported by the backup engine.
export type ManifestObjectRow = typeof manifestObjects.$inferSelect;
export type NewManifestObjectRow = typeof manifestObjects.$inferInsert;
export type ManifestObjectKind = (typeof manifestObjectKindEnum.enumValues)[number];
