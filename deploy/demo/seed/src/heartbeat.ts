import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApi } from "./agent-api.js";
import { type AgentStateEntry, nextHeartbeatDelay, nextRunFor, parseState } from "./agent-state.js";
import { parseSimConfig } from "./run-sim.js";
import { RunSimulator, type SimMachine, sleep } from "./run-simulator.js";

/**
 * The demo's agent sidecar (`agent-sim`, deploy/demo/README.md, "Simulated
 * machines" and "Simulated live runs"): a long-running process that keeps the
 * simulated machines online and plays their live runs. The seed backs them up
 * for real once, during the nightly reset; without this a real agent's
 * five-minute heartbeat would be missing and the server would show as silent a
 * few hours later. It reads the logins the seed left on a shared volume and
 * sends `POST /agent/v1/heartbeat` for each machine, with the seed token the
 * demo guard needs for every write.
 *
 * Unless `RESTOW_DEMO_SIM_RUNS=false`, it also plays simulated backups of the
 * machines (run-simulator.ts): a run with live progress every few minutes, so
 * the demo's job list, throughput chart and run detail have something moving.
 * It never starts a real backup or a restore: the demo guard refuses every
 * request that would queue one, a task it is handed is ignored, and an
 * `update_config` task only makes it fetch the configuration again, as the
 * agent does.
 *
 * It stops cleanly on SIGTERM/SIGINT: a simulated run in progress is closed as
 * interrupted, then the process exits.
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the demo agent sidecar`);
  }
  return value;
}

/** How long the sidecar takes at most to stop after SIGTERM. */
const STOP_DEADLINE_MS = 8_000;

const log = (message: string) => console.log(`[demo-agent-sim] ${message}`);

async function waitForState(path: string, signal: AbortSignal): Promise<AgentStateEntry[] | null> {
  let announced = false;
  while (!signal.aborted) {
    try {
      return parseState(readFileSync(path, "utf8")).agents;
    } catch (error) {
      if (!announced) {
        log(
          `waiting for the seed to write ${path} (${error instanceof Error ? error.message : error})`,
        );
        announced = true;
      }
      await sleep(10_000, signal);
    }
  }
  return null;
}

interface Machine {
  entry: AgentStateEntry;
  api: AgentApi;
  running: boolean;
}

async function beat(machine: Machine): Promise<void> {
  const { entry, api } = machine;
  const answer = await api.heartbeat({
    agentVersion: entry.agentVersion,
    osVersion: entry.osVersion,
    state: machine.running ? "running" : "idle",
    nextRunAt: nextRunFor(entry, new Date())?.toISOString() ?? null,
    configVersion: entry.configVersion,
  });
  for (const task of answer.tasks) {
    if (task.kind === "update_config") {
      entry.configVersion = Number((await api.config()).configVersion);
    } else {
      log(`${entry.hostname}: ignoring a ${task.kind} task`);
    }
  }
}

/** A heartbeat now, outside the rhythm (a run started or ended); a failure waits for the next one. */
function beatNow(machine: Machine): void {
  beat(machine).catch((error: unknown) => {
    log(
      `${machine.entry.hostname}: heartbeat failed (${error instanceof Error ? error.message : error})`,
    );
  });
}

async function keepOnline(machine: Machine, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let delay = nextHeartbeatDelay(Math.random);
    try {
      await beat(machine);
    } catch (error) {
      // Try again soon; a real agent backs off the same way while the server is away.
      log(
        `${machine.entry.hostname}: heartbeat failed (${error instanceof Error ? error.message : error})`,
      );
      delay = 30_000;
    }
    await sleep(delay, signal);
  }
}

async function main(): Promise<void> {
  const apiUrl = requireEnv("RESTOW_API_URL");
  const seedToken = requireEnv("RESTOW_DEMO_SEED_TOKEN");
  const statePath = requireEnv("RESTOW_DEMO_AGENT_STATE");
  const simConfig = parseSimConfig(process.env);

  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      log(`${signal}: stopping`);
      stop.abort();
      // Docker waits 10 s before it kills; whatever has not ended by then is cut short here.
      setTimeout(() => process.exit(0), STOP_DEADLINE_MS).unref();
    });
  }

  const agents = await waitForState(statePath, stop.signal);
  if (!agents) {
    return;
  }
  log(
    `keeping ${agents.length} simulated machine(s) online: ${agents.map((a) => a.hostname).join(", ")}`,
  );
  const machines: Machine[] = agents.map((entry) => ({
    entry,
    api: new AgentApi(
      apiUrl,
      seedToken,
      { endpointId: entry.endpointId, secret: entry.agentSecret },
      { timeoutMs: 30_000 },
    ),
    running: false,
  }));
  const work: Promise<void>[] = machines.map((machine) => keepOnline(machine, stop.signal));

  if (simConfig.enabled && machines.length > 0) {
    log(
      `simulating runs: ${simConfig.minDurationMs / 1000}-${simConfig.maxDurationMs / 1000} s each, a rest of about ${simConfig.intervalMs / 1000} s per machine, progress every ${simConfig.progressMs / 1000} s`,
    );
    const credentials = (entry: AgentStateEntry) => ({
      endpointId: entry.endpointId,
      secret: entry.agentSecret,
    });
    const simMachines: SimMachine[] = machines.map((machine) => ({
      entry: machine.entry,
      api: new AgentApi(apiUrl, seedToken, credentials(machine.entry), {
        retries: 2,
        timeoutMs: 15_000,
      }),
      quickApi: new AgentApi(apiUrl, seedToken, credentials(machine.entry), {
        retries: 0,
        timeoutMs: 3_000,
      }),
    }));
    const simulator = new RunSimulator({
      machines: simMachines,
      config: simConfig,
      signal: stop.signal,
      log,
      journalPath:
        process.env.RESTOW_DEMO_SIM_JOURNAL?.trim() || join(tmpdir(), "restow-demo-sim-runs.json"),
      onRunning: (entry, running) => {
        const machine = machines.find((m) => m.entry.endpointId === entry.endpointId);
        if (machine && machine.running !== running) {
          machine.running = running;
          if (!stop.signal.aborted) {
            beatNow(machine);
          }
        }
      },
    });
    work.push(simulator.run());
  } else {
    log("simulated runs are off (RESTOW_DEMO_SIM_RUNS=false)");
  }
  await Promise.all(work);
  log("stopped");
}

main().catch((error: unknown) => {
  console.error(
    `[demo-agent-sim] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
