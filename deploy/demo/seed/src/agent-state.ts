import { nextDailyRun } from "./tz.js";

/**
 * What the seed leaves behind for the demo's heartbeat sidecar (heartbeat.ts):
 * the login and the facts of each simulated machine, in one JSON file on a
 * volume only the seed and the sidecar mount. A real agent keeps the same in
 * `/etc/restow-agent/state.json` (mode 0600). The sidecar keeps the machines
 * "online" between the nightly resets, as a real agent does with its heartbeat
 * every five minutes, so the server list never shows a made-up outage, and
 * plays the machines' simulated live runs with them (run-sim.ts).
 */

export interface AgentStateEntry {
  hostname: string;
  endpointId: string;
  agentSecret: string;
  agentVersion: string;
  osVersion: string;
  configVersion: number;
  profile: "server" | "client";
  schedule: { kind: string; timeOfDay?: string; timeZone?: string; intervalMinutes?: number };
  /** The tenant the machine belongs to (company.ts slug): the run simulator runs one job per tenant at a time. */
  tenant?: string;
  /** The folders the machine backs up, for the simulated runs' "current file". */
  paths?: string[];
  /** The newest real snapshot of the machine, which a simulated run reports again (run-sim.ts). */
  lastSnapshotId?: string;
}

export interface AgentStateFile {
  version: 1;
  agents: AgentStateEntry[];
}

/** A full restic snapshot id. */
const SNAPSHOT_ID = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function serializeState(agents: readonly AgentStateEntry[]): string {
  const file: AgentStateFile = { version: 1, agents: [...agents] };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Parse and check the state file; the message of a thrown error says what is wrong. */
export function parseState(text: string): AgentStateFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("the agent state file is not JSON");
  }
  const file = value as Partial<AgentStateFile> | null;
  if (!file || file.version !== 1 || !Array.isArray(file.agents)) {
    throw new Error("the agent state file has an unknown format");
  }
  for (const [index, agent] of file.agents.entries()) {
    const entry = agent as Partial<AgentStateEntry>;
    if (
      typeof entry.hostname !== "string" ||
      typeof entry.endpointId !== "string" ||
      !UUID.test(entry.endpointId) ||
      typeof entry.agentSecret !== "string" ||
      entry.agentSecret === "" ||
      typeof entry.agentVersion !== "string" ||
      typeof entry.osVersion !== "string" ||
      typeof entry.configVersion !== "number" ||
      (entry.profile !== "server" && entry.profile !== "client") ||
      typeof entry.schedule !== "object" ||
      entry.schedule === null ||
      (entry.tenant !== undefined && typeof entry.tenant !== "string") ||
      (entry.paths !== undefined &&
        (!Array.isArray(entry.paths) || entry.paths.some((path) => typeof path !== "string"))) ||
      (entry.lastSnapshotId !== undefined &&
        (typeof entry.lastSnapshotId !== "string" || !SNAPSHOT_ID.test(entry.lastSnapshotId)))
    ) {
      throw new Error(`agent ${index} of the state file is incomplete`);
    }
  }
  return file as AgentStateFile;
}

/** When the machine's next backup is due, as its heartbeat reports it; null when it has no fixed time. */
export function nextRunFor(agent: AgentStateEntry, now: Date): Date | null {
  if (agent.schedule.kind === "daily" && agent.schedule.timeOfDay) {
    return nextDailyRun(now, agent.schedule.timeOfDay, agent.schedule.timeZone ?? "Europe/Berlin");
  }
  if (agent.schedule.kind === "interval" && agent.schedule.intervalMinutes) {
    return new Date(now.getTime() + agent.schedule.intervalMinutes * 60_000);
  }
  return null;
}

/** The agent's heartbeat: every five minutes, give or take a minute so machines do not beat in step. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
export const HEARTBEAT_JITTER_MS = 60_000;

export function nextHeartbeatDelay(random: () => number): number {
  return HEARTBEAT_INTERVAL_MS + Math.round((random() * 2 - 1) * HEARTBEAT_JITTER_MS);
}
