-- 0.4.7: the expiry reminders sent for the central Microsoft 365 app registration (apps/api
-- features/updates/secret-watch.ts). One jsonb column with an empty default: no rewrite.
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "app_secret_alerts" jsonb DEFAULT '{}'::jsonb NOT NULL;
