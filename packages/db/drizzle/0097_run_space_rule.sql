-- 0.5.0: the space backups keep free on a storage target (#99), scale-aware: a share of the
-- target between a minimum and a maximum. The installation's default (`settings.run_space_rule`,
-- `{}`: 5 %, at least 20 GiB, at most 500 GiB) and a storage target's own (`space_rule`, null:
-- the tenant's and the installation's). Two columns, one defaulted: no rewrite of either table.
-- Self-contained: the number may change when the branch is merged.
--> statement-breakpoint
ALTER TABLE "storage_targets" ADD COLUMN "space_rule" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "run_space_rule" jsonb DEFAULT '{}'::jsonb NOT NULL;
