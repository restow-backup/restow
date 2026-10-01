-- Hand-written guard (not generated): an Entra tenant may belong to one source of
-- the whole installation from now on. Earlier versions only enforced this per
-- Restow tenant, so an installation could hold the same Entra tenant twice. Which
-- binding is legitimate cannot be decided automatically; stop with a readable
-- message instead of the bare unique-violation of CREATE UNIQUE INDEX below.
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(format('%s (sources: %s)', entra_tenant_id, source_ids), '; ')
    INTO duplicates
    FROM (
      SELECT entra_tenant_id, string_agg(id::text, ', ' ORDER BY created_at) AS source_ids
        FROM "sources"
       WHERE entra_tenant_id IS NOT NULL
       GROUP BY entra_tenant_id
      HAVING count(*) > 1
    ) AS shared;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'Entra tenants connected to more than one source: %', duplicates
      USING HINT = 'Clear entra_tenant_id on every source that must not own the tenant, then run the migration again.';
  END IF;
END $$;--> statement-breakpoint
DROP INDEX "sources_tenant_entra_uq";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "auth_method" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "setup_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_entra_tenant_uq" ON "sources" USING btree ("entra_tenant_id") WHERE "sources"."entra_tenant_id" IS NOT NULL;--> statement-breakpoint
-- Hand-written data step (not generated): installations that finished setup under
-- the old rule (settings written and a provider admin present) keep the wizard
-- closed. From here on the lock is one-way and independent of accounts and roles.
UPDATE "settings" SET "setup_completed_at" = coalesce("updated_at", now())
 WHERE "setup_completed_at" IS NULL
   AND "operating_mode" IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "user"
      WHERE 'admin' = ANY (string_to_array(replace(lower(coalesce("role", '')), ' ', ''), ','))
   );
