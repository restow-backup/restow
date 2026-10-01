ALTER TYPE "public"."source_kind" ADD VALUE 'import';--> statement-breakpoint
ALTER TYPE "public"."job_queue" ADD VALUE 'import';--> statement-breakpoint
ALTER TYPE "public"."job_queue" ADD VALUE 'export';--> statement-breakpoint
ALTER TYPE "public"."archive_capture" ADD VALUE 'file_import';--> statement-breakpoint
ALTER TABLE "import_upload_segments" DROP CONSTRAINT "import_upload_segments_upload_id_segment_index_pk";--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_upload_segments" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "import_upload_segments_uq" ON "import_upload_segments" USING btree ("upload_id","segment_index");