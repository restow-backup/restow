CREATE TABLE "endpoint_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"snapshot_id" text NOT NULL,
	"selection" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "endpoint_downloads" ADD CONSTRAINT "endpoint_downloads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_downloads" ADD CONSTRAINT "endpoint_downloads_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_downloads" ADD CONSTRAINT "endpoint_downloads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "endpoint_downloads_endpoint_idx" ON "endpoint_downloads" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "endpoint_downloads_expires_idx" ON "endpoint_downloads" USING btree ("expires_at");