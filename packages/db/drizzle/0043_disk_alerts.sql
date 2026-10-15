-- The low disk space warning (#73, docs/DATABASE.md): per watched disk (the database's and the
-- local default repository's), whether it was last seen low and when that was reported, so the
-- warning goes out once per episode and not after every api restart.
ALTER TABLE "settings" ADD COLUMN "disk_alerts" jsonb DEFAULT '{}'::jsonb NOT NULL;