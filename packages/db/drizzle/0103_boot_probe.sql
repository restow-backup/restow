-- 0.5.0, bare metal M5 (docs/BAREMETAL.md 12.3, 14.2): the report kind of the boot probe, the
-- recovery kind of the lab's sessions and what the worker knows of the lab (settings.recovery_lab,
-- installation-level). Two enum values, used by no statement here, and a nullable column without a
-- default: nothing is rewritten.
--> statement-breakpoint
ALTER TYPE "public"."endpoint_report_kind" ADD VALUE 'boot_probe';--> statement-breakpoint
ALTER TYPE "public"."endpoint_recovery_kind" ADD VALUE 'probe';--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "recovery_lab" jsonb;