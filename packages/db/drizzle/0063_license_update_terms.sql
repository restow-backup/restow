-- 0.4.5: the update terms of a licence key (ee/licensing entitlement.ts, docs/LICENSING.md
-- "Updates"): its major version series, the last day of its update period and the id of
-- the vendor key it was signed with. All nullable: a row of a key installed before (every
-- one of them a beta licence) reads as series "1" without an update period. Installation
-- table (no tenant, no Row Level Security), like the rest of `license`.
ALTER TABLE "license" ADD COLUMN "series" text;--> statement-breakpoint
ALTER TABLE "license" ADD COLUMN "updates_until" date;--> statement-breakpoint
ALTER TABLE "license" ADD COLUMN "signing_key_id" text;