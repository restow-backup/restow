import { readFileSync } from "node:fs";
import { AgentApi } from "./agent-api.js";
import { type AgentStateEntry, nextHeartbeatDelay, nextRunFor, parseState } from "./agent-state.js";

/**
 * The demo's heartbeat sidecar (deploy/demo/README.md, "Simulated machines"):
 * a long-running process that keeps the simulated machines online. The seed
 * backs them up once, during the nightly reset; without this a real agent's
 * five-minute heartbeat would be missing and the server would show as silent
 * a few hours later. It reads the logins the seed left on a shared volume and
 * sends `POST /agent/v1/heartbeat` for each machine, with the seed token the
 * demo guard needs for every write. It never starts a backup or a restore: the
 * demo guard refuses every request that would queue one, and an `update_config`
 * task only makes it fetch the configuration again, as the agent does.
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the demo heartbeat sidecar`);
  }
  return value;
}

const log = (message: string) => console.log(`[demo-heartbeat] ${message}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForState(path: string): Promise<AgentStateEntry[]> {
  let announced = false;
  for (;;) {
    try {
      return parseState(readFileSync(path, "utf8")).agents;
    } catch (error) {
      if (!announced) {
        log(
          `waiting for the seed to write ${path} (${error instanceof Error ? error.message : error})`,
        );
        announced = true;
      }
      await sleep(10_000);
    }
  }
}

async function beat(agent: AgentStateEntry, api: AgentApi): Promise<void> {
  const answer = await api.heartbeat({
    agentVersion: agent.agentVersion,
    osVersion: agent.osVersion,
    state: "idle",
    nextRunAt: nextRunFor(agent, new Date())?.toISOString() ?? null,
    configVersion: agent.configVersion,
  });
  for (const task of answer.tasks) {
    if (task.kind === "update_config") {
      agent.configVersion = Number((await api.config()).configVersion);
    } else {
      log(`${agent.hostname}: ignoring a ${task.kind} task`);
    }
  }
}

async function run(agent: AgentStateEntry, apiUrl: string, seedToken: string): Promise<never> {
  const api = new AgentApi(apiUrl, seedToken, {
    endpointId: agent.endpointId,
    secret: agent.agentSecret,
  });
  for (;;) {
    let delay = nextHeartbeatDelay(Math.random);
    try {
      await beat(agent, api);
    } catch (error) {
      // Try again soon; a real agent backs off the same way while the server is away.
      log(
        `${agent.hostname}: heartbeat failed (${error instanceof Error ? error.message : error})`,
      );
      delay = 30_000;
    }
    await sleep(delay);
  }
}

async function main(): Promise<void> {
  const apiUrl = requireEnv("RESTOW_API_URL");
  const seedToken = requireEnv("RESTOW_DEMO_SEED_TOKEN");
  const statePath = requireEnv("RESTOW_DEMO_AGENT_STATE");
  const agents = await waitForState(statePath);
  log(
    `keeping ${agents.length} simulated machine(s) online: ${agents.map((a) => a.hostname).join(", ")}`,
  );
  await Promise.all(agents.map((agent) => run(agent, apiUrl, seedToken)));
}

main().catch((error: unknown) => {
  console.error(
    `[demo-heartbeat] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
