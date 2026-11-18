-- 0.5.1, bare metal onto a fresh machine without ISO (docs/BAREMETAL-ONESHOT.md 7): the recovery
-- kind of a code that the command on the fresh machine redeems before the machine switches into
-- the recovery environment, and its state (what the machine reported, what the admin decided).
-- One enum value, used by no statement here, and a nullable column without a default: nothing is
-- rewritten. The journal time lies between 0104 and the migrations of 0.6.0, which renumber.
--> statement-breakpoint
ALTER TYPE "public"."endpoint_recovery_kind" ADD VALUE 'oneshot';--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD COLUMN "oneshot" jsonb;
