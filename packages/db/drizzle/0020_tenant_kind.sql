CREATE TYPE "public"."tenant_kind" AS ENUM('customer', 'internal');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "kind" "tenant_kind" DEFAULT 'customer' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_internal_uq" ON "tenants" USING btree ("provider_id") WHERE "tenants"."kind" = 'internal';