ALTER TABLE "tenants" ADD COLUMN "agent_updates_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_rules" ADD COLUMN "recipient_category" text;--> statement-breakpoint
CREATE UNIQUE INDEX "report_rules_recipient_category_uq" ON "report_rules" USING btree ("tenant_id","recipient_category") WHERE "report_rules"."recipient_category" IS NOT NULL;--> statement-breakpoint
-- Data migration: the tenant-wide pause of agent updates used to be stored on every machine of the
-- tenant. A tenant whose machines are all paused took that switch; it becomes the tenant's own
-- setting (a machine enrolled later is covered by it). Nothing is deleted: the flags on the
-- machines stay and keep working, and the pages show them as the machines' own pauses. Both tables
-- force Row Level Security even for their owner (sql/rls.sql), so the force is lifted for this one
-- statement and restored right after; sql/rls.sql applies it again after every migration run.
ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "endpoints" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "tenants" SET "agent_updates_paused" = true
WHERE EXISTS (SELECT 1 FROM "endpoints" e WHERE e."tenant_id" = "tenants"."id")
  AND NOT EXISTS (
    SELECT 1 FROM "endpoints" e
    WHERE e."tenant_id" = "tenants"."id"
      AND COALESCE(e."settings" ->> 'autoUpdatePaused', 'false') <> 'true'
  );--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "endpoints" FORCE ROW LEVEL SECURITY;
