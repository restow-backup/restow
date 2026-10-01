import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgentApi } from "./agent-api.js";
import { nextRunFor, serializeState } from "./agent-state.js";
import type { Logger } from "./api-seed.js";
import { ENDPOINT_PLAN, type RunWindow, backdateRuns, databaseNow } from "./backdate.js";
import { SimAgent } from "./endpoint-agent.js";
import {
  DEMO_MACHINES,
  type DemoMachine,
  applyOps,
  assertEmptyRoots,
  hostPath,
  planEndpointHistory,
  screenshotsIn,
} from "./endpoint-files.js";
import { type ApiClient, ApiRequestError } from "./http-client.js";
import { mulberry32, seedFrom } from "./prng.js";
import { startResticProxy } from "./restic-proxy.js";

/**
 * The history of the demo's simulated machines (deploy/demo/README.md,
 * "Simulated machines"). The seed plays the Restow agent for a Linux file
 * server and a MacBook: for every simulated backup day it changes the
 * machine's files (endpoint-files.ts), backs them up with real restic through
 * the real agent API, asks the server for the restore test of that backup,
 * waits for its result and answers the restore test the server hands back to
 * the agent. Afterwards everything the server wrote for a backup (the run, its
 * samples, the reports, the tasks, the machine's own rows) is moved to the
 * backup's simulated moment (backdate.ts), the way the mailbox history is.
 *
 * Nothing is faked: every snapshot is a restic snapshot in the machine's
 * repository on the server, can be browsed and downloaded, and the readiness
 * of each machine is the server's own verdict after a passed restore test.
 */

export interface EndpointPhaseOptions {
  /** The signed-in seed client (api-seed.ts), for the admin side: tokens, configuration, restore tests. */
  client: ApiClient;
  /** Tenant id by slug (company.ts). */
  tenants: ReadonlyMap<string, string>;
  apiBaseUrl: string;
  seedToken: string;
  /** Where the simulated machines' file systems are rooted (`/` in the demo compose project). */
  root: string;
  seed: number;
  now: Date;
  /** Simulated days of history; 0 is one backup per machine, now, and nothing is moved. */
  days: number;
  screenshotDir: string;
  resticBin: string;
  /** Private working folder for restic's caches and temporary files. */
  workDir: string;
  /** Where the logins for the heartbeat sidecar are written; none when empty. */
  statePath?: string;
  /** The installation role's connection string; without it nothing is backdated. */
  databaseUrl?: string;
  machines?: readonly DemoMachine[];
  /** How long to wait for the server's restore test of one backup. */
  restoreTestTimeoutMs?: number;
  log: Logger;
}

export interface EndpointPhaseResult {
  backups: number;
  machines: ReadonlyArray<{
    hostname: string;
    endpointId: string;
    snapshots: number;
    state: string;
  }>;
}

interface ReportView {
  kind: string;
  origin: string;
  snapshotId: string | null;
  readiness: string | null;
  checkedAt?: string;
}

export interface EndpointDetailView {
  id: string;
  reports: ReportView[];
  lastRetentionAt: string | null;
  lastCheckAt: string | null;
  readiness: { state: string };
}

/**
 * Pure: the newest report of `kind` and `origin` for exactly this snapshot, or
 * null. With `since`, only a report whose check started at or after that moment
 * counts: a test somebody else (the scheduler, right after a machine's first
 * backup) started earlier says nothing about the test just asked for.
 */
export function findReport(
  detail: Pick<EndpointDetailView, "reports">,
  kind: string,
  origin: string,
  snapshotId: string,
  since?: Date,
): ReportView | null {
  return (
    detail.reports.find(
      (report) =>
        report.kind === kind &&
        report.origin === origin &&
        report.snapshotId === snapshotId &&
        (since === undefined ||
          (report.checkedAt !== undefined && new Date(report.checkedAt) >= since)),
    ) ?? null
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Call `check` until it answers something, or `timeoutMs` passes. */
export async function pollUntil<T>(
  check: () => Promise<T | null>,
  options: { timeoutMs: number; intervalMs: number; what: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const found = await check();
    if (found !== null) {
      return found;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${options.what}`);
    }
    await sleep(options.intervalMs);
  }
}

async function expectOk<T>(
  call: Promise<{ status: number; body: T }>,
  method: string,
  path: string,
): Promise<T> {
  const answer = await call;
  if (answer.status >= 400) {
    throw new ApiRequestError(method, path, answer.status, answer.body);
  }
  return answer.body;
}

export async function runEndpointPhase(
  options: EndpointPhaseOptions,
): Promise<EndpointPhaseResult> {
  const { client, log } = options;
  const machines = options.machines ?? DEMO_MACHINES;
  const screenshots = screenshotsIn(options.screenshotDir);
  const steps = planEndpointHistory({
    seed: options.seed,
    now: options.now,
    days: options.days,
    screenshots,
    machines,
  });
  assertEmptyRoots(options.root, machines);
  const restoreTestTimeoutMs = options.restoreTestTimeoutMs ?? 8 * 60_000;
  const backdate = options.databaseUrl !== undefined && options.days > 0;
  const databaseUrl = options.databaseUrl ?? "";
  const windowClock = async () => (backdate ? databaseNow(databaseUrl) : new Date());

  const proxy = await startResticProxy(options.apiBaseUrl, options.seedToken);
  const agents = new Map<string, SimAgent>();
  for (const machine of machines) {
    agents.set(
      machine.hostname,
      new SimAgent({
        machine,
        api: new AgentApi(options.apiBaseUrl, options.seedToken),
        proxyOrigin: proxy.origin,
        resticBin: options.resticBin,
        workDir: options.workDir,
        rng: mulberry32(seedFrom(`${options.seed}:sample:${machine.hostname}`)),
        log,
      }),
    );
  }
  const tenantOf = (machine: DemoMachine): string => {
    const id = options.tenants.get(machine.tenantSlug);
    if (!id) {
      throw new Error(`tenant "${machine.tenantSlug}" of ${machine.hostname} was not created`);
    }
    return id;
  };
  const detailOf = (machine: DemoMachine, agent: SimAgent) =>
    client.get<EndpointDetailView>(`/api/v1/endpoints/${agent.endpointId}`, {
      tenantId: tenantOf(machine),
    });

  const windows: Array<RunWindow> = [];
  const snapshots = new Map<string, number>();
  try {
    for (const step of steps) {
      const machine = machines.find((m) => m.hostname === step.machine) as DemoMachine;
      const agent = agents.get(machine.hostname) as SimAgent;
      const tenantId = tenantOf(machine);
      const start = await windowClock();

      if (!agent.enrolled) {
        await enroll(options, machine, agent, tenantId);
      }
      const written = applyOps(options.root, step.ops, options.screenshotDir, step.at);
      // The heartbeat the agent sends before it works; it also picks up the configuration change.
      await agent.heartbeat(nextRunFor(agent.state(), step.at));
      const outcome = await agent.backup(step.at);
      snapshots.set(machine.hostname, (snapshots.get(machine.hostname) ?? 0) + 1);
      log(
        `${machine.hostname} ${step.at.toISOString().slice(0, 16)}Z: ${written.written} written, ${written.removed} removed; snapshot ${outcome.snapshotId.slice(0, 8)} (${outcome.summary.filesNew} new, ${outcome.summary.filesChanged} changed)`,
      );
      if (step.index === 0) {
        // The scheduler gives a new machine its first retention and repository check at once;
        // let them finish before the restore test, so none of them holds the repository then.
        await waitForMaintenance(() => detailOf(machine, agent), log, machine.hostname);
      }
      await restoreTest(client, tenantId, agent, outcome.snapshotId, {
        timeoutMs: restoreTestTimeoutMs,
        detail: () => detailOf(machine, agent),
        log,
      });
      windows.push({ start, end: await windowClock(), target: step.at });
    }
  } finally {
    await proxy.close();
  }

  if (backdate) {
    await backdateRuns(databaseUrl, windows, log, ENDPOINT_PLAN);
  }

  // The agents' next heartbeat, now: it ends any "silent" state the move into the past could
  // have caused, and carries the next run that is due.
  for (const machine of machines) {
    const agent = agents.get(machine.hostname) as SimAgent;
    if (agent.enrolled) {
      await agent.heartbeat(nextRunFor(agent.state(), new Date()));
    }
  }
  if (options.statePath) {
    mkdirSync(dirname(options.statePath), { recursive: true });
    writeFileSync(
      options.statePath,
      serializeState(machines.map((machine) => (agents.get(machine.hostname) as SimAgent).state())),
      { mode: 0o600 },
    );
    log(`wrote the logins of the simulated machines to ${options.statePath}`);
  }

  const result: Array<EndpointPhaseResult["machines"][number]> = [];
  for (const machine of machines) {
    const agent = agents.get(machine.hostname) as SimAgent;
    const detail = await detailOf(machine, agent);
    result.push({
      hostname: machine.hostname,
      endpointId: agent.endpointId,
      snapshots: snapshots.get(machine.hostname) ?? 0,
      state: detail.readiness.state,
    });
  }
  return { backups: steps.length, machines: result };
}

async function enroll(
  options: EndpointPhaseOptions,
  machine: DemoMachine,
  agent: SimAgent,
  tenantId: string,
): Promise<void> {
  const { client, log } = options;
  const path = "/api/v1/endpoints/tokens";
  log(`creating the enrollment token of ${machine.hostname}...`);
  const token = await client.post<{ token: string }>(
    path,
    { profile: machine.kind, os: machine.os, displayName: machine.displayName },
    { tenantId, seed: true },
  );
  await agent.enroll(token.token);
  // What an administrator sets in the UI after the enrollment: the folders to back up.
  const change = `/api/v1/endpoints/${agent.endpointId}`;
  await expectOk(
    client.request("PATCH", change, {
      tenantId,
      seed: true,
      body: { config: { paths: machine.paths.map((p) => hostPath(options.root, p)) } },
    }),
    "PATCH",
    change,
  );
}

/** Wait until the retention and the repository check the scheduler starts for a new machine have run. */
async function waitForMaintenance(
  detail: () => Promise<EndpointDetailView>,
  log: Logger,
  hostname: string,
): Promise<void> {
  try {
    await pollUntil(
      async () => {
        const current = await detail();
        return current.lastRetentionAt && current.lastCheckAt ? current : null;
      },
      {
        timeoutMs: 90_000,
        intervalMs: 3000,
        what: `the first retention and check of ${hostname}`,
      },
    );
  } catch (error) {
    // Not fatal: the restore test below is retried by the server if the repository is busy.
    log(`${error instanceof Error ? error.message : error}; continuing`);
  }
}

/**
 * Ask for the restore test of the newest backup, wait for the server's verdict (it must be
 * green), then give the agent its half: the same files restored on the machine itself.
 */
async function restoreTest(
  client: ApiClient,
  tenantId: string,
  agent: SimAgent,
  snapshotId: string,
  context: {
    timeoutMs: number;
    detail: () => Promise<EndpointDetailView>;
    log: Logger;
  },
): Promise<void> {
  const path = `/api/v1/endpoints/${agent.endpointId}/restore-test`;
  const name = `snapshot ${snapshotId.slice(0, 8)} of ${agent.machine.hostname}`;
  // A restore test can come out red for no fault of the backup when it runs while the
  // scheduler's first retention and repository check of a new machine hold the repository
  // (all three start at once): asking again settles it, and a repository that really is
  // damaged fails every time. Only a test started after the request counts.
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const requestedAt = new Date();
    await expectOk(client.request("POST", path, { tenantId, seed: true, body: {} }), "POST", path);
    const report = await pollUntil(
      async () =>
        findReport(await context.detail(), "restore_test", "server", snapshotId, requestedAt),
      {
        timeoutMs: context.timeoutMs,
        intervalMs: 1000,
        what: `the restore test of ${name}`,
      },
    );
    if (report.readiness === "green") {
      break;
    }
    if (attempt >= attempts) {
      throw new Error(`the restore test of ${name} did not pass (${report.readiness})`);
    }
    context.log(`the restore test of ${name} was ${report.readiness}; asking again`);
  }
  // The server hands the same files to the agent as a verify_sample task a moment after its own report.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const tasks = await agent.heartbeat();
    if (tasks.some((task) => task.kind === "verify_sample")) {
      break;
    }
    if (Date.now() >= deadline) {
      context.log(
        `${agent.machine.hostname}: no restore test task for the agent within a minute; continuing`,
      );
      break;
    }
    await sleep(1000);
  }
  const verified = await pollUntil(
    async () => findReport(await context.detail(), "restore_test", "agent", snapshotId) ?? null,
    {
      timeoutMs: 30_000,
      intervalMs: 1000,
      what: `the agent's restore test of ${agent.machine.hostname}`,
    },
  ).catch(() => null);
  if (verified && verified.readiness !== "green") {
    throw new Error(
      `the agent's restore test of snapshot ${snapshotId.slice(0, 8)} of ${agent.machine.hostname} did not pass`,
    );
  }
}
