-- 0.4.4, archive capture beyond Exchange journaling (docs/ARCHIVE.md "Erfassungswege"):
-- capture streams per archived mailbox and way (the worker's capture service claims them with a
-- lease), mail announced by Graph notifications and not fetched yet, Graph subscriptions, the
-- per-account archive addresses for forwarded copies, further captures of an archived mail
-- (append-only evidence next to the chain), the capture ways of a mail job, and on archive_items
-- the body hash, where a mailbox capture found the mail and which weaker item it supersedes.
-- The indexes on archive_items serve duplicate detection and the chain tip under the chain lock.
--> statement-breakpoint
CREATE TYPE "public"."archive_capture_way" AS ENUM('graph_sync', 'imap_sync');--> statement-breakpoint
CREATE TYPE "public"."archive_stream_status" AS ENUM('pending', 'backfilling', 'live', 'paused', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "public"."graph_subscription_status" AS ENUM('active', 'reauthorization_required', 'removed', 'failed');--> statement-breakpoint
CREATE TABLE "archive_item_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"archive_item_id" uuid NOT NULL,
	"captured_via" "archive_capture" NOT NULL,
	"protected_object_id" uuid,
	"item_hash" text NOT NULL,
	"external_ref" text,
	"received_at" timestamp with time zone NOT NULL,
	"flags" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archive_capture_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"way" "archive_capture_way" NOT NULL,
	"external_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archive_capture_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"way" "archive_capture_way" NOT NULL,
	"status" "archive_stream_status" DEFAULT 'pending' NOT NULL,
	"activated_at" timestamp with time zone,
	"backfill_job_id" uuid,
	"backfill_completed_at" timestamp with time zone,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dirty_since" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_capture_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archive_forward_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"resource" text NOT NULL,
	"client_state_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "graph_subscription_status" DEFAULT 'active' NOT NULL,
	"last_notification_at" timestamp with time zone,
	"last_lifecycle_event" text,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "body_hash" text;--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "supersedes_item_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD COLUMN "archive_capture" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_item_captures" ADD CONSTRAINT "archive_item_captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_item_captures" ADD CONSTRAINT "archive_item_captures_archive_item_id_archive_items_id_fk" FOREIGN KEY ("archive_item_id") REFERENCES "public"."archive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_item_captures" ADD CONSTRAINT "archive_item_captures_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_capture_pending" ADD CONSTRAINT "archive_capture_pending_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_capture_pending" ADD CONSTRAINT "archive_capture_pending_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_capture_streams" ADD CONSTRAINT "archive_capture_streams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_capture_streams" ADD CONSTRAINT "archive_capture_streams_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_capture_streams" ADD CONSTRAINT "archive_capture_streams_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_forward_addresses" ADD CONSTRAINT "archive_forward_addresses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_forward_addresses" ADD CONSTRAINT "archive_forward_addresses_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_forward_addresses" ADD CONSTRAINT "archive_forward_addresses_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_subscriptions" ADD CONSTRAINT "graph_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_subscriptions" ADD CONSTRAINT "graph_subscriptions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_subscriptions" ADD CONSTRAINT "graph_subscriptions_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archive_item_captures_item_idx" ON "archive_item_captures" USING btree ("tenant_id","archive_item_id");--> statement-breakpoint
CREATE INDEX "archive_item_captures_via_received_idx" ON "archive_item_captures" USING btree ("tenant_id","captured_via","received_at");--> statement-breakpoint
CREATE INDEX "archive_item_captures_object_external_ref_idx" ON "archive_item_captures" USING btree ("protected_object_id","external_ref") WHERE "archive_item_captures"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_capture_pending_object_way_ref_uq" ON "archive_capture_pending" USING btree ("protected_object_id","way","external_ref");--> statement-breakpoint
CREATE INDEX "archive_capture_pending_tenant_idx" ON "archive_capture_pending" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "archive_capture_streams_object_way_uq" ON "archive_capture_streams" USING btree ("protected_object_id","way");--> statement-breakpoint
CREATE INDEX "archive_capture_streams_due_idx" ON "archive_capture_streams" USING btree ("next_due_at") WHERE "archive_capture_streams"."next_due_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "archive_capture_streams_tenant_status_idx" ON "archive_capture_streams" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "archive_forward_addresses_token_uq" ON "archive_forward_addresses" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "archive_forward_addresses_object_active_uq" ON "archive_forward_addresses" USING btree ("protected_object_id") WHERE "archive_forward_addresses"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "archive_forward_addresses_tenant_idx" ON "archive_forward_addresses" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_subscriptions_subscription_uq" ON "graph_subscriptions" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "graph_subscriptions_expiry_idx" ON "graph_subscriptions" USING btree ("expires_at") WHERE "graph_subscriptions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "graph_subscriptions_object_active_uq" ON "graph_subscriptions" USING btree ("protected_object_id") WHERE "graph_subscriptions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "archive_items_tenant_message_key_idx" ON "archive_items" USING btree ("tenant_id",lower(btrim("message_id", '<> ')));--> statement-breakpoint
CREATE INDEX "archive_items_tenant_item_hash_idx" ON "archive_items" USING btree ("tenant_id","item_hash");--> statement-breakpoint
CREATE INDEX "archive_items_object_external_ref_idx" ON "archive_items" USING btree ("protected_object_id","external_ref") WHERE "archive_items"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "archive_items_supersedes_idx" ON "archive_items" USING btree ("supersedes_item_id") WHERE "archive_items"."supersedes_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "archive_items_tenant_created_idx" ON "archive_items" USING btree ("tenant_id","created_at","id");