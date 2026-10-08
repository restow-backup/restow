CREATE TABLE "warning_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protected_object_id" uuid,
	"endpoint_id" uuid,
	"causes" text[] DEFAULT '{}'::text[] NOT NULL,
	"run_id" uuid,
	"note" text,
	"acknowledged_by_user_id" text,
	"acknowledged_by" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warning_acknowledgements_one_target_ck" CHECK (("warning_acknowledgements"."protected_object_id" IS NOT NULL) <> ("warning_acknowledgements"."endpoint_id" IS NOT NULL)),
	CONSTRAINT "warning_acknowledgements_note_ck" CHECK ("warning_acknowledgements"."note" IS NULL OR char_length("warning_acknowledgements"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "item_failures" ADD COLUMN "item_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "item_failure_summary" jsonb;--> statement-breakpoint
ALTER TABLE "warning_acknowledgements" ADD CONSTRAINT "warning_acknowledgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warning_acknowledgements" ADD CONSTRAINT "warning_acknowledgements_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warning_acknowledgements" ADD CONSTRAINT "warning_acknowledgements_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warning_acknowledgements" ADD CONSTRAINT "warning_acknowledgements_acknowledged_by_user_id_user_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warning_acknowledgements_tenant_idx" ON "warning_acknowledgements" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warning_acknowledgements_object_uq" ON "warning_acknowledgements" USING btree ("protected_object_id") WHERE "warning_acknowledgements"."protected_object_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "warning_acknowledgements_endpoint_uq" ON "warning_acknowledgements" USING btree ("endpoint_id") WHERE "warning_acknowledgements"."endpoint_id" IS NOT NULL;