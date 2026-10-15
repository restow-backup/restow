-- Container file restore (#62): a prepared ZIP download of files of a container restore point,
-- bound to the admin who prepared it, single use and short-lived (like endpoint_downloads).
CREATE TABLE "pve_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"selection" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pve_downloads" ADD CONSTRAINT "pve_downloads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_downloads" ADD CONSTRAINT "pve_downloads_snapshot_id_pve_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."pve_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_downloads" ADD CONSTRAINT "pve_downloads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pve_downloads_snapshot_idx" ON "pve_downloads" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "pve_downloads_expires_idx" ON "pve_downloads" USING btree ("expires_at");