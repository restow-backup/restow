ALTER TABLE "settings" ADD COLUMN "disclaimer_version" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "disclaimer_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "disclaimer_accepted_ip" text;