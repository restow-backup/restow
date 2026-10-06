CREATE TABLE "archive_item_mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"archive_item_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mail_addresses" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD COLUMN "archive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "archive_item_mailboxes" ADD CONSTRAINT "archive_item_mailboxes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_item_mailboxes" ADD CONSTRAINT "archive_item_mailboxes_archive_item_id_archive_items_id_fk" FOREIGN KEY ("archive_item_id") REFERENCES "public"."archive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_item_mailboxes" ADD CONSTRAINT "archive_item_mailboxes_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_item_mailboxes_item_object_uq" ON "archive_item_mailboxes" USING btree ("archive_item_id","protected_object_id");--> statement-breakpoint
CREATE INDEX "archive_item_mailboxes_object_idx" ON "archive_item_mailboxes" USING btree ("tenant_id","protected_object_id");