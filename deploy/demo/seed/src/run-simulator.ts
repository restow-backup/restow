import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentApi } from "./agent-api.js";
import type { AgentStateEntry } from "./agent-state.js";
import { ApiRequestError } from "./http-client.js";
import { type Rng, mulberry32 } from "./prng.js";
import {
  type MachineSlot,
  type SimConfig,
  backoffMs,
  finishOf,
  initialSlots,
  interruptedFinish,
  nextToStart,
  planRun,
  restAfterRun,
} from "./run-sim.js";

/**
 * The impure half of the demo's run simulator (run-sim.ts has the pure one;
 * deploy/demo/README.md, "Simulated live runs"). It runs inside the heartbeat
 * sidecar (heartbeat.ts) with the logins the seed left for the simulated
 * machines, and plays their backups on the real agent API: start the run, post
 * a progress report every few seconds for a few minutes, finish it. Nothing is
 * read or uploaded and the repository does not change (the finished run reports
 * the machine's newest real snapshot again), so the demo's storage never grows.
 *
 * It stops cleanly: on the stop signal a run in progress is finished as
 * interrupted, as a real agent restarted mid-run reports it (no alert, no
 * "failed" for the machine), and the ids of the runs in flight are kept in a
 * small journal, so a sidecar that was killed instead closes them the same way
 * when it starts again rather than leaving them "running" for hours. While the
 * API is away it backs off (5 s, doubling, at most 5 minutes) instead of
 * hammering it.
 */

/** What the simulator needs of the agent API client. */
export type SimAgentApi = Pick<AgentApi, "startRun" | "progress" | "finishRun">;

export interface SimMachine {
  entry: AgentStateEntry;
  /** The client for the run (retries a little, times out). */
  api: SimAgentApi;
  /** The client for the last word on the way out: no retries, a short timeout. */
  quickApi: SimAgentApi;
}

export interface RunSimulatorOptions {
  machines: readonly SimMachine[];
  config: SimConfig;
  signal: AbortSignal;
  log: (message: string) => void;
  /** Told when a machine starts or stops running, so its heartbeat can say so. */
  onRunning?: (entry: AgentStateEntry, running: boolean) => void;
  /** Where the ids of the runs in flight are kept; none when empty. */
  journalPath?: string;
  rng?: Rng;
  /** How often the scheduler looks whether a run is due (1 s). */
  tickMs?: number;
  /** How often the end of a run is tried while the API is away (10). */
  finishAttempts?: number;
}

/** A pause that ends early when `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The run is gone on the server (finished, closed by the monitor, or the demo was reset). */
function isGone(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 401);
}

type Journal = Record<string, string>;

export class RunSimulator {
  private readonly rng: Rng;
  private readonly journal: Journal = {};
  /** Failed calls in a row; the next run waits {@link backoffMs} of it. */
  private failures = 0;
  private notBefore = 0;

  constructor(private readonly options: RunSimulatorOptions) {
    this.rng = options.rng ?? mulberry32((Date.now() ^ process.pid) >>> 0);
  }

  /** Play runs until the signal fires; resolves once every run in flight has been closed. */
  async run(): Promise<void> {
    const { machines, config, signal, log } = this.options;
    await this.closeLeftovers();
    const slots = initialSlots(
      machines.map((machine) => ({
        id: machine.entry.endpointId,
        // Without a tenant in the state file, treat all machines as one tenant: never two at once.
        tenant: machine.entry.tenant ?? "unknown",
      })),
      Date.now(),
      config.intervalMs,
    );
    const inFlight = new Set<Promise<void>>();
    while (!signal.aborted) {
      const now = Date.now();
      const id = now >= this.notBefore ? nextToStart(slots, now) : null;
      const slot = slots.find((candidate) => candidate.id === id);
      const machine = machines.find((candidate) => candidate.entry.endpointId === id);
      if (slot && machine) {
        slot.running = true;
        const played = this.play(machine, slot).finally(() => inFlight.delete(played));
        inFlight.add(played);
      }
      await sleep(this.options.tickMs ?? 1000, signal);
    }
    await Promise.allSettled([...inFlight]);
    log("run simulator stopped");
  }

  private noteSuccess(): void {
    this.failures = 0;
    this.notBefore = 0;
  }

  private noteFailure(): number {
    this.failures += 1;
    const wait = backoffMs(this.failures);
    this.notBefore = Date.now() + wait;
    return wait;
  }

  private async play(machine: SimMachine, slot: MachineSlot): Promise<void> {
    try {
      await this.playRun(machine);
    } finally {
      slot.running = false;
      slot.lastEndedAt = Date.now();
      slot.restUntil = Math.max(
        slot.lastEndedAt + restAfterRun(this.options.config.intervalMs, this.rng),
        this.notBefore,
      );
    }
  }

  private async playRun(machine: SimMachine): Promise<void> {
    const { config, signal, log } = this.options;
    const { entry, api } = machine;
    const plan = planRun(entry, config, this.rng);
    const startedAt = new Date();
    let runId: string;
    try {
      runId = await api.startRun({ kind: "backup", startedAt: startedAt.toISOString() });
    } catch (error) {
      const wait = this.noteFailure();
      log(
        `${entry.hostname}: could not start a run (${messageOf(error)}); next try in ${Math.round(wait / 1000)} s`,
      );
      return;
    }
    this.noteSuccess();
    this.remember(entry.endpointId, runId);
    this.options.onRunning?.(entry, true);
    log(
      `${entry.hostname}: run ${runId} started, ${Math.round(plan.durationMs / 1000)} s, ${plan.points.length} reports`,
    );
    try {
      for (const point of plan.points) {
        const { atMs, ...report } = point;
        await sleep(startedAt.getTime() + atMs - Date.now(), signal);
        if (signal.aborted) {
          await this.interrupt(machine, runId);
          return;
        }
        try {
          await api.progress(runId, report);
          this.noteSuccess();
        } catch (error) {
          if (isGone(error)) {
            log(`${entry.hostname}: run ${runId} is gone on the server; dropping it`);
            this.forget(entry.endpointId);
            return;
          }
          // The run goes on, like an agent whose report did not get through; the next one may.
          this.noteFailure();
          log(`${entry.hostname}: progress of run ${runId} not delivered (${messageOf(error)})`);
        }
      }
      await this.finish(machine, runId, plan, startedAt);
    } finally {
      this.options.onRunning?.(entry, false);
    }
  }

  private async finish(
    machine: SimMachine,
    runId: string,
    plan: ReturnType<typeof planRun>,
    startedAt: Date,
  ): Promise<void> {
    const { signal, log } = this.options;
    const { entry, api } = machine;
    const attempts = this.options.finishAttempts ?? 10;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signal.aborted) {
        await this.interrupt(machine, runId);
        return;
      }
      try {
        await api.finishRun(
          runId,
          finishOf(plan, {
            startedAt,
            finishedAt: new Date(),
            agentVersion: entry.agentVersion,
            ...(entry.lastSnapshotId ? { snapshotId: entry.lastSnapshotId } : {}),
          }),
        );
        this.noteSuccess();
        this.forget(entry.endpointId);
        log(`${entry.hostname}: run ${runId} finished ${plan.status}`);
        return;
      } catch (error) {
        if (isGone(error)) {
          this.forget(entry.endpointId);
          log(`${entry.hostname}: run ${runId} is gone on the server; dropping it`);
          return;
        }
        const wait = this.noteFailure();
        log(
          `${entry.hostname}: could not finish run ${runId} (${messageOf(error)}), attempt ${attempt} of ${attempts}`,
        );
        await sleep(wait, signal);
      }
    }
    // Left in the journal: the next start closes it, or the server's monitor does.
    log(`${entry.hostname}: giving up on finishing run ${runId} for now`);
  }

  /** Close a run as interrupted, with one quick try: the process is on its way out. */
  private async interrupt(machine: SimMachine, runId: string): Promise<void> {
    try {
      await machine.quickApi.finishRun(runId, interruptedFinish(new Date()));
      this.forget(machine.entry.endpointId);
      this.options.log(`${machine.entry.hostname}: run ${runId} closed as interrupted`);
    } catch (error) {
      if (isGone(error)) {
        this.forget(machine.entry.endpointId);
      }
      this.options.log(
        `${machine.entry.hostname}: could not close run ${runId} (${messageOf(error)}); the next start closes it`,
      );
    }
  }

  /** Runs a killed sidecar left behind: close them as interrupted, as an agent does after a restart. */
  private async closeLeftovers(): Promise<void> {
    const path = this.options.journalPath;
    if (!path) {
      return;
    }
    let left: Journal = {};
    try {
      left = JSON.parse(readFileSync(path, "utf8")) as Journal;
    } catch {
      return;
    }
    for (const [endpointId, runId] of Object.entries(left)) {
      const machine = this.options.machines.find((m) => m.entry.endpointId === endpointId);
      if (!machine || typeof runId !== "string") {
        continue;
      }
      try {
        await machine.api.finishRun(runId, interruptedFinish(new Date()));
        this.options.log(`${machine.entry.hostname}: closed run ${runId} left from before`);
      } catch (error) {
        this.options.log(
          `${machine.entry.hostname}: run ${runId} left from before not closed (${messageOf(error)})`,
        );
      }
    }
    this.save();
  }

  private remember(endpointId: string, runId: string): void {
    this.journal[endpointId] = runId;
    this.save();
  }

  private forget(endpointId: string): void {
    delete this.journal[endpointId];
    this.save();
  }

  private save(): void {
    const path = this.options.journalPath;
    if (!path) {
      return;
    }
    try {
      if (Object.keys(this.journal).length === 0) {
        rmSync(path, { force: true });
      } else {
        writeFileSync(path, JSON.stringify(this.journal), { mode: 0o600 });
      }
    } catch (error) {
      this.options.log(`could not write the run journal ${path} (${messageOf(error)})`);
    }
  }
}
