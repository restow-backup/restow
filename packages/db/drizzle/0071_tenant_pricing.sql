-- 0.4.8: a tenant's own prices (apps/api settings/tenant-pricing.ts). One jsonb column with an
-- empty default: no rewrite of the table, every tenant keeps taking the installation's prices.
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pricing" jsonb DEFAULT '{}'::jsonb NOT NULL;
