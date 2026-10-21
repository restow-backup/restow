-- The installation's time zone (0.4.2, docs/UPDATING.md "The installation's time zone"): chosen in
-- the setup wizard or under Installation > Server, used for planned updates and as the zone of new
-- tenants. Null (every existing installation) keeps the previous order: RESTOW_TIME_ZONE, then TZ,
-- then Europe/Berlin.
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "time_zone" text;
