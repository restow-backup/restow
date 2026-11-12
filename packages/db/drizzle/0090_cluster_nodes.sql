-- 0.5.0: worker nodes on other hosts (docs/SIZING.md, "Several hosts: worker nodes"): the one-time
-- join tokens of Installation > Cluster and the nodes that joined (both installation-level, no Row
-- Level Security), and the restore mode source `setup` (a restore from a dump in the setup wizard
-- or install.sh --restore). New tables and one widened check only.
--> statement-breakpoint
CREATE TABLE "cluster_join_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"node_name" text NOT NULL,
	"expected_address" "inet",
	"db_address" text NOT NULL,
	"standby_scheduler" boolean DEFAULT false NOT NULL,
	"created_by" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_from" "inet",
	"revoked_at" timestamp with time zone,
	"revoked_by" jsonb,
	"node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"address" "inet",
	"db_login" text NOT NULL,
	"db_installation_login" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"standby_scheduler" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cluster_nodes_status" CHECK ("cluster_nodes"."status" IN ('active', 'removed'))
);
--> statement-breakpoint
ALTER TABLE "installation_restore_mode" DROP CONSTRAINT "installation_restore_mode_source";--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_join_tokens_hash_uq" ON "cluster_join_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "cluster_join_tokens_open_idx" ON "cluster_join_tokens" USING btree ("expires_at") WHERE "cluster_join_tokens"."used_at" IS NULL AND "cluster_join_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_nodes_active_name_uq" ON "cluster_nodes" USING btree ("name") WHERE "cluster_nodes"."status" = 'active';--> statement-breakpoint
ALTER TABLE "installation_restore_mode" ADD CONSTRAINT "installation_restore_mode_source" CHECK ("installation_restore_mode"."source" IN ('cli', 'api', 'detected', 'setup'));