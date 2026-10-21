-- The objects of one person in a tenant (the restore explorer lists people, #49), and the
-- ON DELETE SET NULL from users without a scan of every protected object.
--> statement-breakpoint
CREATE INDEX "protected_objects_tenant_user_idx" ON "protected_objects" USING btree ("tenant_id","user_id");
