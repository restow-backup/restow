ALTER TABLE "tenants" ADD COLUMN "journal_token" text;--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "chunks" jsonb;--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "flags" jsonb;--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "body_text" text;--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "has_attachment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_journal_token_uq" ON "tenants" USING btree ("journal_token") WHERE "tenants"."journal_token" IS NOT NULL;--> statement-breakpoint
-- Full text search over archived items (docs/ARCHIVE.md, Volltextsuche):
-- subject, extracted body text and the envelope (cast to text so every
-- address is a searchable token), folded into one 'simple' (unstemmed)
-- tsvector so the same index serves German and English content. Must stay
-- byte-identical to archiveSearchVectorSql in schema/archive.ts, which
-- builds the matching WHERE clause.
CREATE INDEX IF NOT EXISTS "archive_items_search_idx" ON "archive_items" USING GIN (
  (to_tsvector('simple',
    coalesce("subject", '') || ' ' ||
    coalesce("body_text", '') || ' ' ||
    coalesce("envelope"::text, '')
  ))
);