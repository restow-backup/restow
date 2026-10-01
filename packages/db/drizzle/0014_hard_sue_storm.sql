CREATE TYPE "public"."update_channel" AS ENUM('stable', 'beta');--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "update_check_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "update_source_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "update_channel" "update_channel" DEFAULT 'stable' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "update_check" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "update_notified_version" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "update_audit_cursor" text;
