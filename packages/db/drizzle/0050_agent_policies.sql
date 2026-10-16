-- Agent policies (docs/AGENT.md, "Richtlinien"): the installation's policy for the agents of
-- servers and clients with its locks, and each tenant's level of it. `{}` sets nothing, which is
-- what the agents did before policies existed. A job's level lives in its settings.
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "agent_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "agent_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;