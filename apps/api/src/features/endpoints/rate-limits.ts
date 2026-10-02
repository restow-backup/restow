/**
 * The request limits of the agent API, per endpoint, in one place without any dependency, so the
 * agent's own cadence can be tested against them (rate-limits.test.ts).
 *
 * What an agent sends while it works: a heartbeat every 5 minutes, one progress report every 5
 * seconds of a run (the agent's default, docs/AGENT.md), the start and the end of the run and a
 * look at its configuration. The limit is a sliding window of 10 minutes; an agent that reports
 * every 5 seconds uses about 125 of the 600 calls in it, and a report every second would still
 * fit (600 calls in 10 minutes is one per second on average, with nothing else being sent).
 */

export const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Calls to the JSON agent API (`/agent/v1`) per endpoint and 10 minutes. */
export const AGENT_API_LIMIT = 600;
/** Requests to the restic REST endpoint (`/agent/restic`) per endpoint and 10 minutes. */
export const RESTIC_API_LIMIT = 20_000;
