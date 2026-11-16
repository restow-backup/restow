-- 0.5.0: the modules of the installation (what it protects), asked by the setup wizard and changed
-- under Installation > Modules. The column holds the ids of the modules switched off; `{}` hides
-- none, so an installation that updates keeps every module it showed. One defaulted column: no
-- rewrite of the table. Self-contained: the number may change when the branch is merged.
ALTER TABLE "settings" ADD COLUMN "modules" jsonb DEFAULT '{}'::jsonb NOT NULL;
