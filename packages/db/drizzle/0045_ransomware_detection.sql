-- Ransomware detection on backups (docs/RANSOMWARE.md): the judgement of every restore point of a
-- machine, file share, Proxmox VE guest, mailbox, OneDrive or IMAP account (verdict, findings with
-- their numbers, the signals that could be judged, the metrics of the baseline, the episode's alert
-- and an administrator's false alarm), and the installation's thresholds (`{}`: every default).
--> statement-breakpoint
CREATE TABLE "restore_point_suspicions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"restore_point_id" text NOT NULL,
	"restore_point_at" timestamp with time zone NOT NULL,
	"verdict" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"signatures_version" text NOT NULL,
	"alerted_at" timestamp with time zone,
	"false_alarm_at" timestamp with time zone,
	"false_alarm_by_user_id" text,
	"false_alarm_by" text,
	"false_alarm_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restore_point_suspicions_kind_ck" CHECK ("restore_point_suspicions"."object_kind" IN ('endpoint', 'file_share', 'pve_guest', 'm365')),
	CONSTRAINT "restore_point_suspicions_verdict_ck" CHECK ("restore_point_suspicions"."verdict" IN ('none', 'suspicious')),
	CONSTRAINT "restore_point_suspicions_note_ck" CHECK ("restore_point_suspicions"."false_alarm_note" IS NULL OR char_length("restore_point_suspicions"."false_alarm_note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "ransomware_detection" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD CONSTRAINT "restore_point_suspicions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_point_suspicions" ADD CONSTRAINT "restore_point_suspicions_false_alarm_by_user_id_user_id_fk" FOREIGN KEY ("false_alarm_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "restore_point_suspicions_run_uq" ON "restore_point_suspicions" USING btree ("object_kind","run_id");--> statement-breakpoint
CREATE INDEX "restore_point_suspicions_object_idx" ON "restore_point_suspicions" USING btree ("tenant_id","object_kind","object_id","restore_point_at");--> statement-breakpoint
CREATE INDEX "restore_point_suspicions_tenant_verdict_idx" ON "restore_point_suspicions" USING btree ("tenant_id","verdict");