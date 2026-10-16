-- What a due backup of a machine waits for, as the agent's last heartbeat said (agent 0.4.0,
-- docs/AGENT.md "Richtlinien"): a code such as `backup_window`; '' when nothing waits; null when
-- unknown (an older agent does not say). Shown on the machine's page.
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "agent_waiting" text;
