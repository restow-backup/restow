CREATE TYPE "public"."webhook_format" AS ENUM('restow', 'discord', 'slack', 'teams');--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "format" "webhook_format" DEFAULT 'restow' NOT NULL;
-- Existing webhooks keep the signed JSON envelope (`restow`): the default fills the column. The
-- chat formats (`discord`, `slack`, `teams`) are chosen per webhook and are sent unsigned.
