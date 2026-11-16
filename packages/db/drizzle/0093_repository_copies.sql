-- 0.5.0: repository copies (docs/STORAGE.md, "restic repositories on copies"). The restic
-- repositories of containers, machines and file shares are kept on every copy target as well;
-- one row per repository and copy target records how far the copy is. A new table only, no
-- rewrite of any table. Tenant isolation of the new table is in sql/rls.sql.
--> statement-breakpoint
CREATE TABLE "repository_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"target_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"primary_snapshots" integer DEFAULT 0 NOT NULL,
	"missing_snapshots" integer DEFAULT 0 NOT NULL,
	"last_snapshot_id" text,
	"last_copied_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"last_forgotten" integer DEFAULT 0 NOT NULL,
	"deletions_deferred" text,
	"last_check_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_check_message" text,
	"last_data_check_at" timestamp with time zone,
	"trouble_since" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_copies" ADD CONSTRAINT "repository_copies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repository_copies_uq" ON "repository_copies" USING btree ("tenant_id","prefix","target_id");--> statement-breakpoint
CREATE INDEX "repository_copies_owner_idx" ON "repository_copies" USING btree ("tenant_id","owner_id");