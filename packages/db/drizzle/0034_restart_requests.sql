-- 0.3.6: services that need a manual restart, and why (packages/db/src/restart-requests.ts).
-- Installation-level; the installation role alone reads and writes it (roles.ts TABLE_ACCESS).
CREATE TABLE "restart_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" "service_role" NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restart_requests_reason_key" CHECK ("restart_requests"."reason" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "restart_requests_service_reason_uq" ON "restart_requests" USING btree ("service","reason");