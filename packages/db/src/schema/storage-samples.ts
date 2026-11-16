import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdOnly } from "./_shared.js";
import { tenants } from "./tenants.js";

/**
 * What a sample measures: the tenant's chunk store (the sealed packs of mail and OneDrive data,
 * one source per tenant, `source_id` is null) or the restic repository of one machine, file
 * share or Proxmox VE container (`source_id` is its id).
 */
export const STORAGE_SAMPLE_KINDS = ["chunk_store", "endpoint", "file_share", "pve_guest"] as const;
export type StorageSampleKind = (typeof STORAGE_SAMPLE_KINDS)[number];

/** Samples older than this many days are removed by the daily sampler. */
export const STORAGE_SAMPLE_RETENTION_DAYS = 400;

/**
 * One measurement per day of the bytes a source stores (the capacity page, apps/api
 * features/capacity). The worker writes them once a day (apps/worker storage-samples.ts) from the
 * sums of the packs and the `repository_bytes` columns, which keep no history of their own: a
 * restic repository gets a growth rate from the day the first sample exists, and the chunk store
 * gets growth that pruning does not shrink after the fact (the pack dates are net growth).
 *
 * A day is the UTC day of the measurement. Every sampling run of a tenant writes its
 * `chunk_store` row (also with 0 bytes) together with the rows of all its repositories, so a day
 * with a `chunk_store` row has all of that tenant's rows; the unique constraint treats the null
 * `source_id` of the chunk store as one value, so there is at most one row per source and day.
 * The rows of a machine, share or container that is gone age out with the retention.
 */
export const storageSamples = pgTable(
  "storage_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<StorageSampleKind>().notNull(),
    sourceId: uuid("source_id"),
    day: date("day", { mode: "string" }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    ...createdOnly(),
  },
  (t) => [
    unique("storage_samples_source_day_uq")
      .on(t.tenantId, t.sourceKind, t.sourceId, t.day)
      .nullsNotDistinct(),
    index("storage_samples_day_idx").on(t.day),
    check(
      "storage_samples_kind_ck",
      sql`${t.sourceKind} IN ('chunk_store', 'endpoint', 'file_share', 'pve_guest')`,
    ),
    check(
      "storage_samples_source_ck",
      sql`(${t.sourceKind} = 'chunk_store') = (${t.sourceId} IS NULL)`,
    ),
    check("storage_samples_bytes_ck", sql`${t.bytes} >= 0`),
  ],
);

export type StorageSampleRow = typeof storageSamples.$inferSelect;
export type NewStorageSampleRow = typeof storageSamples.$inferInsert;
