-- 0.5.0 (#89): who belongs to a Microsoft 365 group or a SharePoint site, filled by the directory
-- sync, so the restore explorer lists a person's Teams and sites. A new table, empty at first: no
-- rewrite of any table. Tenant isolation is in sql/rls.sql.
--> statement-breakpoint
CREATE TABLE "directory_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protected_object_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_memberships_role_ck" CHECK ("directory_memberships"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
ALTER TABLE "directory_memberships" ADD CONSTRAINT "directory_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_memberships" ADD CONSTRAINT "directory_memberships_protected_object_id_protected_objects_id_fk" FOREIGN KEY ("protected_object_id") REFERENCES "public"."protected_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_memberships" ADD CONSTRAINT "directory_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_memberships_object_user_uq" ON "directory_memberships" USING btree ("protected_object_id","user_id");--> statement-breakpoint
CREATE INDEX "directory_memberships_user_idx" ON "directory_memberships" USING btree ("user_id","protected_object_id");