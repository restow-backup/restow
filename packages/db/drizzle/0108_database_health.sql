-- 0.6.0, databases D2 (docs/DATABASES.md 8, 9): health checks of the database connections. A new
-- tenant table `database_health_samples` (Row Level Security in sql/rls.sql) holds one row per
-- check, later one per hour; each connection gets its interval (1 to 60 minutes, default 5) and the
-- state the worker keeps (`health`). The task kind `db_health` hands an agent its checks. A new
-- table, an enum value used by no statement here and two columns with a constant default or none:
-- nothing is rewritten.
--
-- Numbered 0108 after the billing migrations 0106 and 0107 of the same release.
--> statement-breakpoint
ALTER TYPE "public"."endpoint_task_kind" ADD VALUE 'db_health';--> statement-breakpoint
CREATE TABLE "database_health_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"resolution" text DEFAULT 'raw' NOT NULL,
	"executor_kind" text NOT NULL,
	"checks" integer DEFAULT 1 NOT NULL,
	"ok_checks" integer NOT NULL,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer,
	"latency_min_ms" integer,
	"latency_max_ms" integer,
	"server_version" text,
	"started_at" timestamp with time zone,
	"connections_used" integer,
	"connections_used_max" integer,
	"connections_max" integer,
	"tls_fingerprint" text,
	"instance_key" text,
	"sizes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_health_samples_resolution_ck" CHECK ("database_health_samples"."resolution" IN ('raw', 'hour')),
	CONSTRAINT "database_health_samples_executor_ck" CHECK ("database_health_samples"."executor_kind" IN ('agent', 'server')),
	CONSTRAINT "database_health_samples_checks_ck" CHECK ("database_health_samples"."checks" >= 1 AND "database_health_samples"."ok_checks" BETWEEN 0 AND "database_health_samples"."checks")
);
--> statement-breakpoint
ALTER TABLE "database_connections" ADD COLUMN "health_interval_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "database_connections" ADD COLUMN "health" jsonb;--> statement-breakpoint
ALTER TABLE "database_health_samples" ADD CONSTRAINT "database_health_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_health_samples" ADD CONSTRAINT "database_health_samples_connection_id_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."database_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "database_health_samples_connection_at_uq" ON "database_health_samples" USING btree ("connection_id","at","resolution");--> statement-breakpoint
CREATE INDEX "database_health_samples_tenant_at_idx" ON "database_health_samples" USING btree ("tenant_id","at");--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_health_interval_ck" CHECK ("database_connections"."health_interval_minutes" BETWEEN 1 AND 60);