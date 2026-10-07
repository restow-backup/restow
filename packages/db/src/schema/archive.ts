import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
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
import { createdOnly, timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { protectedObjects } from "./sources.js";
import { tenants } from "./tenants.js";

/** How an archive item was captured (see docs/ARCHIVE.md, Erfassungswege). */
export const archiveCaptureEnum = pgEnum("archive_capture", [
  "journal",
  "graph_sync",
  "imap_sync",
  // Mail files imported into an imported mailbox and archived with it (docs/IMPORT.md).
  "file_import",
]);

/** Retention clock start: from the capture date, or from calendar year-end
 *  (AO § 147 Abs. 4). Years null = unlimited. */
export const retentionModeEnum = pgEnum("retention_mode", ["from_capture", "end_of_year"]);

export type ArchiveEnvelope = {
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  recipients?: string[];
};

/**
 * An immutable archived message. Stored byte-exact in the chunk store under
 * `tenants/<tid>/archive/<year>/<month>/<id>`. Per-item hash chain:
 * `chainHash = SHA-256(prevChainHash || itemHash || received_at)`; the daily
 * anchor lands in `archive_anchor`. Immutable, so there is no `updated_at`.
 */
export const archiveItems = pgTable(
  "archive_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // Which protected mailbox this assignment belongs to (one original may be
    // assigned to several mailboxes; envelope recipients are kept per assignment).
    protectedObjectId: uuid("protected_object_id").references(() => protectedObjects.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").notNull(),
    // SHA-256 of the original message/rfc822 bytes.
    itemHash: text("item_hash").notNull(),
    prevChainHash: text("prev_chain_hash"),
    chainHash: text("chain_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    capturedVia: archiveCaptureEnum("captured_via").notNull(),
    // Null = legal hold or unlimited retention; a date = eligible for deletion after.
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    // Object path in storage.
    storagePath: text("storage_path").notNull(),
    // True when the item carries a retention date (`retention_until`), i.e. when the
    // writer asked the target for retention. It does not say that the target enforced
    // S3 Object Lock: that is a property of the bucket (storage_targets.config.objectLock).
    objectLock: boolean("object_lock").notNull().default(false),
    subject: text("subject"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    envelope: jsonb("envelope").$type<ArchiveEnvelope>(),
    // Ordered stored chunk ids (hex) that reconstruct the original via the
    // chunk store; mirrors @restow/core's ArchiveItemRecord.chunks. Kept in
    // the row (not only inside the sealed storage object) so a search or
    // retention run never has to open storage just to find them.
    chunks: jsonb("chunks").$type<string[]>(),
    // Journal parser flags (@restow/core archive/journal.ts), e.g. a
    // malformed report kept anyway and marked incomplete. Never empty array
    // vs null distinction matters: null means "not recorded" (pre-increment-1 rows).
    flags: jsonb("flags").$type<string[]>(),
    // Plain-text body extracted at capture time, for full text search
    // (docs/ARCHIVE.md, Volltextsuche). Not the archival copy of the
    // message — that is the byte-exact original in storage; this column
    // only feeds `search_text` and may be truncated for very large bodies.
    bodyText: text("body_text"),
    hasAttachment: boolean("has_attachment").notNull().default(false),
    // The message's own date (Date: header) when the capture path knows it. Imported
    // mail is captured today but was written years ago; retention counts from
    // `received_at` (the capture), search and display prefer this date.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex("archive_items_tenant_chain_hash_uq").on(t.tenantId, t.chainHash),
    // The journal setup page asks for the newest item and the counts of the last days per
    // capture path (ee/api journal setup): an index range scan instead of a scan of the tenant's archive.
    index("archive_items_tenant_capture_received_idx").on(t.tenantId, t.capturedVia, t.receivedAt),
  ],
);

/**
 * The mailboxes an archived mail belongs to. A journal report names its recipients
 * (and sender), not one mailbox, so the receiver assigns the item to every protected
 * mailbox whose address the envelope names. `archive_items` stays untouched
 * (append-only); an item without a row here belongs to the tenant as a whole.
 * Assignments are never changed, only added; they go with their item (retention run)
 * or their mailbox (deleted object).
 */
export const archiveItemMailboxes = pgTable(
  "archive_item_mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    archiveItemId: uuid("archive_item_id")
      .notNull()
      .references(() => archiveItems.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex("archive_item_mailboxes_item_object_uq").on(t.archiveItemId, t.protectedObjectId),
    index("archive_item_mailboxes_object_idx").on(t.tenantId, t.protectedObjectId),
  ],
);

/** Daily anchor of the archive hash chain (date, last chain value, count). */
export const archiveAnchor = pgTable(
  "archive_anchor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    anchorDate: date("anchor_date").notNull(),
    lastHash: text("last_hash").notNull(),
    count: integer("count").notNull().default(0),
    // Optional external RFC 3161 timestamp token reference.
    externalTimestamp: text("external_timestamp"),
    ...createdOnly(),
  },
  (t) => [uniqueIndex("archive_anchor_tenant_date_uq").on(t.tenantId, t.anchorDate)],
);

/** Retention policy per tenant (default 10 years; 6/8/10/unlimited selectable). */
export const retentionPolicies = pgTable("retention_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Null = unlimited retention.
  years: integer("years"),
  mode: retentionModeEnum("mode").notNull().default("from_capture"),
  isDefault: boolean("is_default").notNull().default(false),
  // Optional scope (e.g. a mailbox group) this policy applies to.
  appliesTo: jsonb("applies_to").$type<Record<string, unknown>>(),
  ...timestamps(),
});

/**
 * Legal hold: blocks deletion for a tenant / mailbox / search result. Requires a
 * documented reason and creator; audited. Overrides retention while active.
 */
export const legalHolds = pgTable("legal_holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  // better-auth identity of the admin who placed the hold.
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  // Optional narrower scope (mailbox / search query) the hold covers.
  protectedObjectId: uuid("protected_object_id").references(() => protectedObjects.id, {
    onDelete: "cascade",
  }),
  scope: jsonb("scope").$type<Record<string, unknown>>(),
  active: boolean("active").notNull().default(true),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  ...timestamps(),
});

/**
 * Full text search over one archived item: subject, extracted body text and
 * the whole envelope (from/to/cc addresses), folded together (search's own
 * scoring cares about presence, not which field matched). The envelope is
 * cast to `text` rather than unnested field by field: index expressions
 * cannot contain a subquery, and casting the whole jsonb value keeps every
 * address searchable as a plain substring token (the 'simple' text search
 * configuration does not stem it). A functional GIN index on this exact
 * expression is created in the migration (see 0008 and docs/ARCHIVE.md,
 * Volltextsuche — stemming is a documented v1 limitation).
 */
export const archiveSearchVectorSql = (t: typeof archiveItems) => sql`to_tsvector('simple',
  coalesce(${t.subject}, '') || ' ' ||
  coalesce(${t.bodyText}, '') || ' ' ||
  coalesce(${t.envelope}::text, ''))`;

export type ArchiveItem = typeof archiveItems.$inferSelect;
export type NewArchiveItem = typeof archiveItems.$inferInsert;
export type ArchiveAnchor = typeof archiveAnchor.$inferSelect;
export type NewArchiveAnchor = typeof archiveAnchor.$inferInsert;
export type RetentionPolicy = typeof retentionPolicies.$inferSelect;
export type NewRetentionPolicy = typeof retentionPolicies.$inferInsert;
export type LegalHold = typeof legalHolds.$inferSelect;
export type NewLegalHold = typeof legalHolds.$inferInsert;
