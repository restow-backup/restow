-- 0.6.0, monthly billing close (docs/ARCHITECTURE.md, "Monatsabschluss der Abrechnung"; Service
-- Provider, ee/api/src/billing-close): the daily samples per tenant, the closed months with their
-- tenants and the corrections. New tables only; nothing existing is rewritten. The append-only
-- triggers of the closed months and corrections, the tenant policies and the grants come from
-- sql/rls.sql and roles.ts after the migrations.
--
-- Applies after 0105_databases (journal entry 106, a `when` later than 0105's: the Drizzle
-- migrator applies a migration only when its `when` is later than the last applied one's).
--> statement-breakpoint
CREATE TABLE "billing_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_type" text,
	"amount" double precision NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"api_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_corrections_amount_ck" CHECK ("billing_corrections"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "billing_period_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"customer_number" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"complete" boolean NOT NULL,
	"sampled_days" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"total" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_period_tenants_period_tenant_uq" UNIQUE("period_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "billing_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" text NOT NULL,
	"time_zone" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"storage_unit" text NOT NULL,
	"storage_billing" text NOT NULL,
	"prices" jsonb NOT NULL,
	"per_tenant_overrides" boolean NOT NULL,
	"days" integer NOT NULL,
	"sampled_days" integer NOT NULL,
	"total" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_periods_period_uq" UNIQUE("period"),
	CONSTRAINT "billing_periods_period_ck" CHECK ("billing_periods"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "billing_periods_bounds_ck" CHECK ("billing_periods"."starts_at" < "billing_periods"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "billing_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"quantities" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_samples_tenant_day_uq" UNIQUE("tenant_id","day")
);
--> statement-breakpoint
ALTER TABLE "billing_corrections" ADD CONSTRAINT "billing_corrections_period_id_billing_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."billing_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_corrections" ADD CONSTRAINT "billing_corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_period_tenants" ADD CONSTRAINT "billing_period_tenants_period_id_billing_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."billing_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_period_tenants" ADD CONSTRAINT "billing_period_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_samples" ADD CONSTRAINT "billing_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_corrections_period_idx" ON "billing_corrections" USING btree ("period_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_period_tenants_tenant_idx" ON "billing_period_tenants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "billing_samples_day_idx" ON "billing_samples" USING btree ("day");