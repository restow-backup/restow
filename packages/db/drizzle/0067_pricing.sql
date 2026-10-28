-- 0.4.7: the provider's prices for the tenant overview (apps/api settings/pricing.ts). One
-- jsonb column with an empty default: no rewrite of the table.
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "pricing" jsonb DEFAULT '{}'::jsonb NOT NULL;
