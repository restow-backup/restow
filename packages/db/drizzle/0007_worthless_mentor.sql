CREATE TYPE "public"."credential_status" AS ENUM('untested', 'ok', 'failed');--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "secret_ref" uuid;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "credential_status" "credential_status";--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "credential_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD COLUMN "credential_error" text;--> statement-breakpoint
ALTER TABLE "protected_objects" ADD CONSTRAINT "protected_objects_secret_ref_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;