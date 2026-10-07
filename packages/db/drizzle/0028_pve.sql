CREATE TABLE "pve_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"storage_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pve_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_node_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pve_guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"vmid" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"node" text,
	"status" text,
	"template" boolean DEFAULT false NOT NULL,
	"privileged" boolean DEFAULT false NOT NULL,
	"agent" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pool" text,
	"disks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disk_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"job_id" uuid,
	"repository_secret_id" uuid,
	"repository_ready_at" timestamp with time zone,
	"last_backup_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_snapshot_id" uuid,
	"last_verify_at" timestamp with time zone,
	"last_restore_test_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pve_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope_all" boolean DEFAULT false NOT NULL,
	"schedule" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pve_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"name" text NOT NULL,
	"helper_version" text,
	"pve_version" text,
	"secret_hash" text NOT NULL,
	"fleecing_storage" text,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pve_run_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"device" text NOT NULL,
	"block_index" integer NOT NULL,
	"zero" boolean NOT NULL,
	"length" integer NOT NULL,
	"sha256" text NOT NULL,
	"chunks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pve_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"node_id" uuid,
	"guest_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"origin" text DEFAULT 'restow' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"archive_name" text,
	"storage_id" text,
	"task_id" uuid,
	"commit_id" uuid,
	"snapshot_id" uuid,
	"devices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"failure" jsonb,
	"log_tail" text,
	"restic_token_hash" text,
	"restic_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pve_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"run_id" uuid,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"archive_name" text NOT NULL,
	"storage_id" text NOT NULL,
	"origin" text DEFAULT 'restow' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"manifest_path" text NOT NULL,
	"guest_config" text DEFAULT '' NOT NULL,
	"firewall_config" text,
	"disks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restic_snapshot_id" text,
	"restic_root" text,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chunk_refs" integer DEFAULT 0 NOT NULL,
	"base_snapshot_id" uuid,
	"backup_at" timestamp with time zone NOT NULL,
	"verify" jsonb,
	"pruned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pve_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"guest_id" uuid,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pve_clusters" ADD CONSTRAINT "pve_clusters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_enrollment_tokens" ADD CONSTRAINT "pve_enrollment_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_enrollment_tokens" ADD CONSTRAINT "pve_enrollment_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD CONSTRAINT "pve_guests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD CONSTRAINT "pve_guests_cluster_id_pve_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."pve_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD CONSTRAINT "pve_guests_job_id_pve_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."pve_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_guests" ADD CONSTRAINT "pve_guests_repository_secret_id_secrets_id_fk" FOREIGN KEY ("repository_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_jobs" ADD CONSTRAINT "pve_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_jobs" ADD CONSTRAINT "pve_jobs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_nodes" ADD CONSTRAINT "pve_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_nodes" ADD CONSTRAINT "pve_nodes_cluster_id_pve_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."pve_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_run_blocks" ADD CONSTRAINT "pve_run_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_run_blocks" ADD CONSTRAINT "pve_run_blocks_run_id_pve_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pve_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_runs" ADD CONSTRAINT "pve_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_runs" ADD CONSTRAINT "pve_runs_cluster_id_pve_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."pve_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_runs" ADD CONSTRAINT "pve_runs_node_id_pve_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."pve_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_runs" ADD CONSTRAINT "pve_runs_guest_id_pve_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."pve_guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_snapshots" ADD CONSTRAINT "pve_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_snapshots" ADD CONSTRAINT "pve_snapshots_cluster_id_pve_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."pve_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_snapshots" ADD CONSTRAINT "pve_snapshots_guest_id_pve_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."pve_guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_tasks" ADD CONSTRAINT "pve_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_tasks" ADD CONSTRAINT "pve_tasks_node_id_pve_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."pve_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_tasks" ADD CONSTRAINT "pve_tasks_guest_id_pve_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."pve_guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pve_tasks" ADD CONSTRAINT "pve_tasks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pve_clusters_fingerprint_uq" ON "pve_clusters" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "pve_clusters_tenant_idx" ON "pve_clusters" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pve_enrollment_tokens_hash_uq" ON "pve_enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "pve_enrollment_tokens_tenant_idx" ON "pve_enrollment_tokens" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pve_guests_cluster_vmid_uq" ON "pve_guests" USING btree ("cluster_id","vmid");--> statement-breakpoint
CREATE INDEX "pve_guests_tenant_idx" ON "pve_guests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "pve_guests_job_idx" ON "pve_guests" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pve_jobs_tenant_name_uq" ON "pve_jobs" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "pve_jobs_tenant_all_uq" ON "pve_jobs" USING btree ("tenant_id") WHERE "pve_jobs"."scope_all";--> statement-breakpoint
CREATE INDEX "pve_jobs_due_idx" ON "pve_jobs" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "pve_nodes_cluster_idx" ON "pve_nodes" USING btree ("cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pve_nodes_cluster_name_active_uq" ON "pve_nodes" USING btree ("cluster_id","name") WHERE "pve_nodes"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pve_run_blocks_run_block_uq" ON "pve_run_blocks" USING btree ("run_id","device","block_index");--> statement-breakpoint
CREATE INDEX "pve_runs_guest_started_idx" ON "pve_runs" USING btree ("guest_id","started_at");--> statement-breakpoint
CREATE INDEX "pve_runs_tenant_created_idx" ON "pve_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "pve_runs_status_idx" ON "pve_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pve_snapshots_guest_sequence_uq" ON "pve_snapshots" USING btree ("guest_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "pve_snapshots_cluster_archive_uq" ON "pve_snapshots" USING btree ("cluster_id","archive_name");--> statement-breakpoint
CREATE INDEX "pve_snapshots_guest_status_idx" ON "pve_snapshots" USING btree ("guest_id","status","backup_at");--> statement-breakpoint
CREATE INDEX "pve_tasks_node_status_idx" ON "pve_tasks" USING btree ("node_id","status");--> statement-breakpoint
CREATE INDEX "pve_tasks_guest_idx" ON "pve_tasks" USING btree ("guest_id","created_at");