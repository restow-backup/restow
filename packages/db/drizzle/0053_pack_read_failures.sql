-- Packs the storage check could not read (a transfer or permission error, not proven damage):
-- one row per pack while its run of consecutive failed checks lasts, so the readiness rating
-- can tell "temporarily unreadable" from damage. A new, empty table: nothing in packs is
-- rewritten, however many packs exist.
--> statement-breakpoint
CREATE TABLE "pack_read_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"first_failed_at" timestamp with time zone NOT NULL,
	"last_failed_at" timestamp with time zone NOT NULL,
	"failed_checks" integer DEFAULT 1 NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pack_read_failures" ADD CONSTRAINT "pack_read_failures_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_read_failures" ADD CONSTRAINT "pack_read_failures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pack_read_failures_pack_uq" ON "pack_read_failures" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX "pack_read_failures_tenant_idx" ON "pack_read_failures" USING btree ("tenant_id");