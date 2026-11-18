-- 0.6.0, databases D4 (docs/DATABASES.md 16 "D4" M3): what a restore of MySQL or MariaDB needs
-- beyond the dump, the schema's character set and collation (a dump without --databases carries no
-- CREATE DATABASE). A column with a constant default: nothing is rewritten (PostgreSQL 11+).
--> statement-breakpoint
ALTER TABLE "database_backups" ADD COLUMN "engine_options" jsonb DEFAULT '{}'::jsonb NOT NULL;
