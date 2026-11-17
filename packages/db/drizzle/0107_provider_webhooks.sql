-- 0.6.0, after 0106_billing_close (docs/ARCHITECTURE.md, "Webhooks des Providers" and
-- "Monatsabschluss der Abrechnung"): the provider's own webhooks, their deliveries in
-- webhook_deliveries (tenant_id and webhook_id become nullable; exactly one owner per row, checked
-- by webhook_deliveries_owner_ck, which every existing row meets), and the prices in force on
-- the day of a billing sample (nullable: samples written before have none and the close falls
-- back to the prices at the close for them). The check scans webhook_deliveries once; the
-- worker prunes it after 30 days, so it is small.
--
-- Journal entry 106 with a `when` later than 0106_billing_close's (see there for the merge with
-- 0105_databases).
--> statement-breakpoint
CREATE TABLE "provider_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" text,
	"url" text NOT NULL,
	"secret_ref" uuid,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failing_since" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failure_alerted_at" timestamp with time zone,
	"last_failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "webhook_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_samples" ADD COLUMN "prices" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "provider_webhook_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_webhooks" ADD CONSTRAINT "provider_webhooks_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_webhooks" ADD CONSTRAINT "provider_webhooks_secret_ref_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_webhooks_provider_idx" ON "provider_webhooks" USING btree ("provider_id");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_provider_webhook_id_provider_webhooks_id_fk" FOREIGN KEY ("provider_webhook_id") REFERENCES "public"."provider_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_provider_webhook_created_idx" ON "webhook_deliveries" USING btree ("provider_webhook_id","created_at") WHERE "webhook_deliveries"."provider_webhook_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_owner_ck" CHECK (("webhook_deliveries"."tenant_id" IS NOT NULL AND "webhook_deliveries"."webhook_id" IS NOT NULL AND "webhook_deliveries"."provider_webhook_id" IS NULL) OR ("webhook_deliveries"."tenant_id" IS NULL AND "webhook_deliveries"."webhook_id" IS NULL AND "webhook_deliveries"."provider_webhook_id" IS NOT NULL));