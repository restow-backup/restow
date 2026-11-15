-- 0.5.0, bare metal M3 (docs/BAREMETAL.md 9.8): whether a recovery session's stored log ends inside
-- a key block (a BEGIN line whose END has not come yet), so the next log batch goes on masking until
-- the END line. A constant default, so the table is not rewritten.
--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD COLUMN "log_in_key_block" boolean DEFAULT false NOT NULL;
