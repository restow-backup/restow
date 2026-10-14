import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
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

const HEX_ID = /^(?:[0-9a-fA-F]{2})*$/;

/**
 * One stored chunk id as the 32 raw bytes of its HMAC-SHA-256 instead of 64
 * hex characters. An id that is not hex (never written by the chunk store;
 * only hand-made test data) is kept as its UTF-8 bytes, the same rule the
 * 0033 conversion applies in SQL, so both sides agree.
 */
export function chunkIdBytes(id: string): Buffer {
  return HEX_ID.test(id) ? Buffer.from(id, "hex") : Buffer.from(id, "utf8");
}

/** Postgres text form of a `bytea[]` of chunk ids (`{"\\x..","\\x.."}`). */
export function chunkIdArrayLiteral(ids: readonly string[]): string {
  return `{${ids.map((id) => `"\\\\x${chunkIdBytes(id).toString("hex")}"`).join(",")}}`;
}

/** Chunk ids from a `bytea[]` value as node-postgres returns it (Buffer[]), or its text form. */
export function chunkIdsFromDriver(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (Buffer.isBuffer(item) ? item.toString("hex") : String(item)));
  }
  if (typeof value === "string") {
    const inner = value.replace(/^\{|\}$/g, "");
    if (inner.length === 0) {
      return [];
    }
    return inner.split(",").map((item) => item.replace(/^"?\\+x/, "").replace(/"$/, ""));
  }
  return [];
}

/** Ordered chunk ids as `bytea[]` (32 bytes per id); the TypeScript side keeps hex strings. */
/** Raw bytes (node-postgres reads and writes `bytea` as a Buffer). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const chunkIdArray = customType<{ data: string[]; driverData: string }>({
  dataType() {
    return "bytea[]";
  },
  toDriver(value) {
    return chunkIdArrayLiteral(value);
  },
  fromDriver(value) {
    return chunkIdsFromDriver(value);
  },
});

/**
 * Searchable index of the snapshot manifests in object storage (the manifest
 * stays the truth for the standalone restore, see docs/ARCHITECTURE.md), kept
 * as VERSIONS: one row is one state of one object that held, unchanged, for
 * the snapshots of its protected object whose `sequence` lies in
 * `[first_sequence, last_sequence]` (`last_sequence` stays open while the
 * object is unchanged in the newest snapshot). Up to 0.3.4 every snapshot
 * copied every object (`manifest_objects`), which grew to tens of millions of
 * rows for a few mailboxes backed up daily; now an unchanged object costs no
 * write at all (packages/db/src/manifest-versions.ts).
 *
 * The rows covering a snapshot are exactly that snapshot's objects: browsing
 * snapshot S is a lookup on (protected_object_id, first <= S.sequence <=
 * last). Sequences of snapshots that no longer exist (pruned, discarded) may
 * lie inside a range; nothing ever browses them. A row is deleted once no
 * active snapshot lies within its range any more.
 *
 * A row is "unchanged" only when every mirrored column is identical (path,
 * size, mtime, ids, chunk list, the mirrored metadata, `deleted`), so what a
 * snapshot shows is what the per-snapshot copy showed. `metadata` leaves out
 * the engines' own bookkeeping keys (MIRROR_OMITTED_METADATA_KEYS): no reader
 * of this index uses them, and the manifest file keeps them.
 *
 * `path` is the logical path within the source ("Inbox/Projects", "Documents/
 * report.docx"); `parentPath` is its directory ("" for the root). `deleted`
 * marks an object the source removed, kept so the explorer can show and
 * restore it.
 */
export const manifestVersions = pgTable(
  "manifest_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    // snapshots.sequence of the first and the last snapshot this version is part of;
    // OPEN_SEQUENCE (2^31 - 1) while it holds in the newest mirrored snapshot.
    firstSequence: integer("first_sequence").notNull(),
    lastSequence: integer("last_sequence").notNull(),
    // 128 bits of SHA-256 over every mirrored column below: equal hash, same version
    // (manifest-versions.ts `storedEntry`). Compared only within one protected object.
    contentHash: bytea("content_hash").notNull(),
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
    // Ordered stored chunk ids (32 bytes each) that reconstruct the object; null for folders.
    chunkRefs: chunkIdArray("chunk_refs"),
    // Source metadata the explorer, preview, restore and export read (subject, from, ...).
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    deleted: boolean("deleted").notNull().default(false),
    ...createdOnly(),
  },
  (t) => [
    index("manifest_versions_object_last_idx").on(t.protectedObjectId, t.lastSequence),
    index("manifest_versions_object_path_idx").on(t.protectedObjectId, t.path),
    index("manifest_versions_object_item_idx").on(t.protectedObjectId, t.itemId),
    check("manifest_versions_range_ck", sql`${t.firstSequence} <= ${t.lastSequence}`),
  ],
);

export type ManifestVersionRow = typeof manifestVersions.$inferSelect;
export type NewManifestVersionRow = typeof manifestVersions.$inferInsert;

/**
 * The per-snapshot mirror of 0.3.4 and earlier (one row per object per
 * snapshot), kept only until the worker has folded it into
 * `manifest_versions` (packages/db/src/manifest-versions.ts,
 * `convertLegacySnapshot`). Nothing writes it any more; the readers include
 * what is left of it, so browsing works while the conversion runs. Its
 * secondary indexes except the per-snapshot one were dropped by migration
 * 0033 to give disk space back at once; the migration step truncates the
 * table once it is empty (src/migrate.ts), which returns the rest. A later
 * release drops it.
 */
export const legacyManifestObjects = pgTable(
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
    itemId: text("item_id"),
    messageId: text("message_id"),
    // Ordered stored chunk ids (hex).
    chunkRefs: jsonb("chunk_refs").$type<string[]>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    deleted: boolean("deleted").notNull().default(false),
    ...createdOnly(),
  },
  (t) => [index("manifest_objects_snapshot_parent_idx").on(t.snapshotId, t.parentPath)],
);

export type LegacyManifestObjectRow = typeof legacyManifestObjects.$inferSelect;
export type NewLegacyManifestObjectRow = typeof legacyManifestObjects.$inferInsert;
export type ManifestObjectKind = (typeof manifestObjectKindEnum.enumValues)[number];
