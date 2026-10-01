import {
  bigint,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { protectedObjects } from "./sources.js";
import { tenants } from "./tenants.js";

export const snapshotStatusEnum = pgEnum("snapshot_status", ["active", "pruned"]);

/**
 * One snapshot per protected object per run. The manifest in object storage is
 * the source of truth for a standalone restore; Postgres mirrors the index for
 * search and restore. `manifestPath` points at `tenants/<tid>/manifests/...`.
 *
 * `jobId` is a soft link to the producing backup job (no FK, to keep a single
 * import direction between the backup and job schema modules).
 */
export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    // Monotonic sequence number of this snapshot within its protected object.
    sequence: integer("sequence").notNull(),
    manifestPath: text("manifest_path"),
    status: snapshotStatusEnum("status").notNull().default("active"),
    itemCount: integer("item_count").notNull().default(0),
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("snapshots_object_sequence_uq").on(t.protectedObjectId, t.sequence)],
);

/**
 * Pack file in the chunk store: many chunks concatenated with an index at the
 * end. `sha256` is over the whole file (integrity/scrub); `path` is relative to
 * the storage root (`tenants/<tid>/packs/<xx>/<packid>`).
 *
 * `damagedAt` is set by the scrub when no storage target holds an intact copy.
 * Chunks of a damaged pack no longer count as stored for deduplication, so
 * the next backup that meets their content writes an intact copy and moves
 * the chunk row to it; the scrub clears the mark when the pack checks intact
 * again and removes the row once no chunk points to it.
 */
export const packs = pgTable(
  "packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    damagedAt: timestamp("damaged_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("packs_tenant_path_uq").on(t.tenantId, t.path)],
);

/**
 * A deduplicated content chunk within a tenant. `storedId` is the stored id
 * (HMAC-SHA-256 with the tenant key, so content cannot be guessed from ids);
 * dedupe is within a tenant only. `refcount` drives garbage collection.
 */
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    storedId: text("stored_id").notNull(),
    length: integer("length").notNull(),
    packId: uuid("pack_id")
      .notNull()
      .references(() => packs.id, { onDelete: "restrict" }),
    // Byte offset of this chunk inside its pack file.
    offsetBytes: bigint("offset_bytes", { mode: "number" }).notNull().default(0),
    refcount: integer("refcount").notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex("chunks_tenant_stored_id_uq").on(t.tenantId, t.storedId)],
);

export type Snapshot = typeof snapshots.$inferSelect;
export type NewSnapshot = typeof snapshots.$inferInsert;
export type Pack = typeof packs.$inferSelect;
export type NewPack = typeof packs.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
