-- 0.4.9: objects an admin confirmed as empty (apps/api verify/empty.ts). A new table, nothing
-- existing is rewritten; Row Level Security comes with sql/rls.sql like every tenant table.
--> statement-breakpoint
CREATE TABLE "empty_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"note" text,
	"confirmed_by_user_id" text,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "empty_confirmations_note_ck" CHECK ("empty_confirmations"."note" IS NULL OR char_length("empty_confirmations"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "empty_confirmations" ADD CONSTRAINT "empty_confirmations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "empty_confirmations" ADD CONSTRAINT "empty_confirmations_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "empty_confirmations" ADD CONSTRAINT "empty_confirmations_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "empty_confirmations" ADD CONSTRAINT "empty_confirmations_confirmed_by_user_id_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "empty_confirmations_tenant_idx" ON "empty_confirmations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "empty_confirmations_object_uq" ON "empty_confirmations" USING btree ("protected_object_id");
