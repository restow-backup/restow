ALTER TABLE "endpoints" ADD COLUMN "assigned_user_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_id_uq" ON "users" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "endpoints_assigned_user_idx" ON "endpoints" USING btree ("assigned_user_id");--> statement-breakpoint
-- The person a machine is assigned to belongs to the machine's own tenant: a second key over
-- (tenant_id, assigned_user_id) refers to the unique (tenant_id, id) of `users`, so the database
-- refuses a person of another tenant even to a caller that bypasses Row Level Security. When the
-- person leaves the directory only the assignment is cleared (the column list of SET NULL keeps
-- tenant_id). Drizzle cannot express either, so the key is written here by hand.
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_assigned_user_tenant_fk" FOREIGN KEY ("tenant_id","assigned_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE SET NULL ("assigned_user_id") ON UPDATE no action;