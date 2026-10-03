import type { FinishRequest, ProgressRequest, RunError } from "./agent-api.js";
import type { AgentStateEntry } from "./agent-state.js";
import { formatBytes, shortId } from "./endpoint-agent.js";
import { type Rng, chance, mulberry32, pick, randomInt, seedFrom } from "./prng.js";

/**
 * The pure half of the demo's run simulator (deploy/demo/README.md, "Simulated
 * live runs"): what a simulated backup of a simulated machine reports while it
 * runs, and when the next one starts. The impure half (run-simulator.ts) posts
 * the plan to the real agent API on the clock: `POST /agent/v1/runs`, a
 * progress report every few seconds, `POST /agent/v1/runs/:id/finish`.
 *
 * Nothing is read or uploaded: the progress is a curve over a made-up data set
 * of the machine's size, and the finished run reports the machine's newest real
 * snapshot again (the one the seed made), so the repository, the restore tests
 * and the readiness stay exactly what the seed proved. Everything here is
 * deterministic for a given random source, so it is tested without a clock.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SimConfig {
  enabled: boolean;
  /** Typical rest of a machine between two of its runs (jittered ±50 %). */
  intervalMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  /** Time between two progress reports of a run (the agent's default is 5 s). */
  progressMs: number;
  /** Share of runs that end partial, with a warning (a file that could not be read). */
  partialRate: number;
}

export const SIM_DEFAULTS: SimConfig = {
  enabled: true,
  intervalMs: 4 * 60_000,
  minDurationMs: 2 * 60_000,
  maxDurationMs: 6 * 60_000,
  progressMs: 5_000,
  partialRate: 0.1,
};

/**
 * Bounds that keep the simulator inside the agent API's limits (600 calls per machine and 10
 * minutes, apps/api endpoints/rate-limits.ts; the server keeps one throughput point per 1.5 s)
 * and short of the monitor's six-hour silence limit.
 */
export const SIM_LIMITS = {
  progressMs: { min: 2_000, max: 60_000 },
  durationMs: { min: 20_000, max: 60 * 60_000 },
  intervalMs: { min: 0, max: 24 * 60 * 60_000 },
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function seconds(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallbackMs: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallbackMs;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number of seconds, not "${raw}"`);
  }
  return Math.round(value * 1000);
}

/**
 * The simulator's settings from the environment (deploy/demo/.env.example):
 *
 *   RESTOW_DEMO_SIM_RUNS                  true (default) or false
 *   RESTOW_DEMO_SIM_INTERVAL_SECONDS      typical rest of a machine between runs, default 240
 *   RESTOW_DEMO_SIM_MIN_DURATION_SECONDS  shortest run, default 120
 *   RESTOW_DEMO_SIM_MAX_DURATION_SECONDS  longest run, default 360
 *   RESTOW_DEMO_SIM_PROGRESS_SECONDS      time between progress reports, default 5
 *
 * Values out of bounds are clamped into {@link SIM_LIMITS}; a value that is not a number is an
 * error, so a typo does not silently fall back.
 */
export function parseSimConfig(env: Readonly<Record<string, string | undefined>>): SimConfig {
  const flag = env.RESTOW_DEMO_SIM_RUNS?.trim().toLowerCase();
  if (flag && !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(flag)) {
    throw new Error(`RESTOW_DEMO_SIM_RUNS must be true or false, not "${flag}"`);
  }
  const enabled = !flag || ["true", "1", "yes", "on"].includes(flag);
  const { durationMs, progressMs, intervalMs } = SIM_LIMITS;
  const minDurationMs = clamp(
    seconds(env, "RESTOW_DEMO_SIM_MIN_DURATION_SECONDS", SIM_DEFAULTS.minDurationMs),
    durationMs.min,
    durationMs.max,
  );
  const maxDurationMs = clamp(
    seconds(env, "RESTOW_DEMO_SIM_MAX_DURATION_SECONDS", SIM_DEFAULTS.maxDurationMs),
    minDurationMs,
    durationMs.max,
  );
  return {
    enabled,
    intervalMs: clamp(
      seconds(env, "RESTOW_DEMO_SIM_INTERVAL_SECONDS", SIM_DEFAULTS.intervalMs),
      intervalMs.min,
      intervalMs.max,
    ),
    minDurationMs,
    maxDurationMs,
    progressMs: clamp(
      seconds(env, "RESTOW_DEMO_SIM_PROGRESS_SECONDS", SIM_DEFAULTS.progressMs),
      progressMs.min,
      progressMs.max,
    ),
    partialRate: SIM_DEFAULTS.partialRate,
  };
}

// ---------------------------------------------------------------------------
// The machine's data set
// ---------------------------------------------------------------------------

export interface Dataset {
  files: number;
  bytes: number;
}

const GIB = 1024 ** 3;

/**
 * The size of the data a simulated machine "has": fixed per machine (seeded by its hostname),
 * a file server's share a little larger than a laptop's home folder. Made up, like the rest:
 * the real snapshots the seed made are a few megabytes.
 */
export function datasetOf(agent: Pick<AgentStateEntry, "hostname" | "profile">): Dataset {
  const rng = mulberry32(seedFrom(`dataset:${agent.hostname}`));
  return agent.profile === "server"
    ? { files: randomInt(rng, 26_000, 34_000), bytes: Math.round((18 + rng() * 8) * GIB) }
    : { files: randomInt(rng, 9_000, 15_000), bytes: Math.round((9 + rng() * 5) * GIB) };
}

// ---------------------------------------------------------------------------
// The current file
// ---------------------------------------------------------------------------

const YEARS = ["2024", "2025", "2026"];
const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

/** Made-up files below one backed-up folder, in the spirit of endpoint-files.ts. */
function fileBelow(root: string, rng: Rng): string {
  const year = pick(rng, YEARS);
  const month = pick(rng, MONTHS);
  const n = String(randomInt(rng, 1, 999)).padStart(4, "0");
  if (root.endsWith("/samba") && root.startsWith("/etc")) {
    return `${root}/${pick(rng, ["smb.conf", "lmhosts", "smb.conf.bak"])}`;
  }
  if (root.startsWith("/var/log")) {
    return `${root}/${pick(rng, ["log.smbd", "log.nmbd", "log.wb-EXAMPLE", "log.smbd.old"])}`;
  }
  if (root.startsWith("/Users/")) {
    return pick(rng, [
      `${root}/Documents/Clients/Proposal-${year}-${n}.pdf`,
      `${root}/Documents/Notes/meeting-${year}-${month}-${randomInt(rng, 10, 28)}.md`,
      `${root}/Desktop/Screenshot ${year}-${month}-${randomInt(rng, 10, 28)} at 10.${randomInt(rng, 10, 59)}.png`,
      `${root}/Pictures/Screenshots/chart-${n}.png`,
      `${root}/Library/Mail/V10/MailData/Envelope Index-${n}`,
      `${root}/Downloads/invoice-${year}-${n}.pdf`,
      `${root}/.zshrc`,
    ]);
  }
  return pick(rng, [
    `${root}/Accounting/${year}/Invoices/INV-${year}-${n}.pdf`,
    `${root}/Accounting/${year}/Reports/monthly-report-${year}-${month}.pdf`,
    `${root}/Sales/Contracts/contract-${year}-${n}.pdf`,
    `${root}/Projects/Website/plan-${year}-${month}.md`,
    `${root}/Projects/Office move/todo.txt`,
    `${root}/Scans/scan-${year}${month}-${n}.pdf`,
    `${root}/Public/Templates/letterhead.odt`,
  ]);
}

// ---------------------------------------------------------------------------
// The run plan
// ---------------------------------------------------------------------------

/** One progress report, `atMs` after the start of the run. */
export interface ProgressPoint extends ProgressRequest {
  atMs: number;
}

export interface RunPlan {
  durationMs: number;
  dataset: Dataset;
  /** The folders backed up. */
  roots: string[];
  /** Every report, the last one at `durationMs` with everything done. */
  points: ProgressPoint[];
  status: "succeeded" | "partial";
  errors: RunError[];
  stats: NonNullable<FinishRequest["stats"]>;
}

/**
 * The weight of each report interval: how much of the data it reads (`bytes`) and how many
 * files (`files`). Restic reads a data set at an uneven pace: it starts slowly while the
 * scanner walks the tree, drifts with the disk and the CPU, bursts through a few large files
 * (many bytes, few files) and crawls through folders of small ones (few bytes, many files).
 */
export function paceOf(steps: number, rng: Rng): { bytes: number[]; files: number[] } {
  const bytes: number[] = [];
  const files: number[] = [];
  const period = 6 + rng() * 18;
  const phase = rng() * 2 * Math.PI;
  let burst = 0;
  let crawl = 0;
  for (let step = 0; step < steps; step++) {
    if (burst === 0 && crawl === 0) {
      if (chance(rng, 0.08)) {
        burst = randomInt(rng, 1, 3);
      } else if (chance(rng, 0.05)) {
        crawl = randomInt(rng, 2, 4);
      }
    }
    const drift = 1 + 0.35 * Math.sin((2 * Math.PI * step) / period + phase);
    const noise = 0.6 + 0.8 * rng();
    let byteWeight = drift * noise;
    let fileWeight = 0.7 + 0.6 * rng();
    if (burst > 0) {
      byteWeight *= 2.2 + 1.3 * rng();
      fileWeight *= 0.3;
      burst--;
    } else if (crawl > 0) {
      byteWeight *= 0.25;
      fileWeight *= 3;
      crawl--;
    }
    if (step === 0) {
      // The scanner has only just begun.
      byteWeight *= 0.3;
      fileWeight *= 0.5;
    }
    bytes.push(byteWeight);
    files.push(fileWeight);
  }
  return { bytes, files };
}

function cumulative(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  let running = 0;
  return weights.map((weight, index) => {
    running += weight;
    return index === weights.length - 1
      ? total
      : Math.min(total, Math.floor((total * running) / sum));
  });
}

/**
 * Plan one simulated backup of `agent`: how long it runs, every progress report, and how it
 * ends. Nothing changed since the snapshot it reports (the seed's newest, see run-simulator.ts),
 * so it says so: every file unmodified, nothing added to the repository, which is also what the
 * server measures (the repository does not grow, so the "uploaded" chart stays at zero). Now
 * and then one file cannot be read and the run ends partial. The first report comes before
 * the scanner has counted the data, so it carries no totals (the run shows no percentage for
 * those first seconds, as with the real agent).
 */
export function planRun(
  agent: Pick<AgentStateEntry, "hostname" | "profile" | "paths">,
  config: Pick<SimConfig, "minDurationMs" | "maxDurationMs" | "progressMs" | "partialRate">,
  rng: Rng,
): RunPlan {
  const dataset = datasetOf(agent);
  const durationMs =
    config.minDurationMs + Math.round(rng() * (config.maxDurationMs - config.minDurationMs));
  const steps = Math.max(1, Math.ceil(durationMs / config.progressMs));
  const pace = paceOf(steps, rng);
  const bytesDone = cumulative(pace.bytes, dataset.bytes);
  const filesDone = cumulative(pace.files, dataset.files);
  const roots = agent.paths && agent.paths.length > 0 ? agent.paths : ["/data"];
  const points: ProgressPoint[] = [];
  for (let step = 0; step < steps; step++) {
    const last = step === steps - 1;
    points.push({
      atMs: last ? durationMs : (step + 1) * config.progressMs,
      filesDone: filesDone[step] as number,
      bytesDone: bytesDone[step] as number,
      ...(step === 0 && !last ? {} : { totalFiles: dataset.files, totalBytes: dataset.bytes }),
      currentPath: fileBelow(pick(rng, roots), rng),
    });
  }

  const partial = chance(rng, config.partialRate);
  const errors: RunError[] = partial
    ? [
        {
          path: fileBelow(pick(rng, roots), rng),
          message: "open: permission denied",
          code: "read_error",
        },
      ]
    : [];
  return {
    durationMs,
    dataset,
    roots: [...roots],
    points,
    status: partial ? "partial" : "succeeded",
    errors,
    stats: {
      filesNew: 0,
      filesChanged: 0,
      filesUnmodified: dataset.files,
      dataAdded: 0,
      totalFilesProcessed: dataset.files,
      totalBytesProcessed: dataset.bytes,
    },
  };
}

function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The run log the agent sends with the end of the run (the lines endpoint-agent.ts writes for a real one). */
export function logTailOf(
  plan: RunPlan,
  input: { startedAt: Date; agentVersion: string; snapshotId?: string },
): string {
  const at = (ms: number) => stamp(new Date(input.startedAt.getTime() + ms));
  const end = at(plan.durationMs);
  const s = plan.stats;
  const lines = [
    `${at(0)} INFO Run started (backup, trigger: scheduled). Agent ${input.agentVersion}.`,
    `${at(0)} INFO Backing up: ${plan.roots.join(", ")}`,
    `${at(plan.points[0]?.atMs ?? 0)} INFO restic: scan finished: ${plan.dataset.files} files, ${formatBytes(plan.dataset.bytes)}`,
    ...plan.errors.map(
      (error) => `${at(plan.durationMs / 2)} WARN restic: error: ${error.path}: ${error.message}`,
    ),
    `${end} INFO restic: Files: ${s.filesNew} new, ${s.filesChanged} changed, ${s.filesUnmodified} unmodified`,
    `${end} INFO restic: Added to the repository: ${formatBytes(s.dataAdded)}`,
    `${end} INFO restic: processed ${s.totalFilesProcessed} files, ${formatBytes(s.totalBytesProcessed)} in ${duration(plan.durationMs)}`,
  ];
  if (input.snapshotId) {
    lines.push(`${end} INFO restic: snapshot ${shortId(input.snapshotId)} saved`);
  }
  if (plan.status === "partial") {
    lines.push(
      `${end} WARN Some files could not be read (${plan.errors.length} errors); the snapshot is incomplete. Details are listed in the errors of this run.`,
    );
  }
  lines.push(`${end} INFO Run finished: ${plan.status}.`);
  return lines.join("\n");
}

/** The end of a planned run, as the agent reports it. */
export function finishOf(
  plan: RunPlan,
  input: { startedAt: Date; finishedAt: Date; agentVersion: string; snapshotId?: string },
): FinishRequest {
  return {
    status: plan.status,
    finishedAt: input.finishedAt.toISOString(),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    stats: plan.stats,
    errors: plan.errors,
    logTail: logTailOf(plan, input),
  };
}

/** The end of a run the simulator was stopped in the middle of: interrupted, like an agent restarted mid-run. */
export function interruptedFinish(finishedAt: Date): FinishRequest {
  return {
    status: "failed",
    finishedAt: finishedAt.toISOString(),
    errors: [
      {
        message: "The agent was stopped while the backup was running; the next run picks it up.",
        code: "interrupted",
      },
    ],
    logTail: `${stamp(finishedAt)} WARN Run interrupted: the agent is stopping.`,
  };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface MachineSlot {
  id: string;
  /** Runs of machines with the same tenant never overlap (the demo's one job per tenant). */
  tenant: string;
  running: boolean;
  /** When its last run ended; null before the first. */
  lastEndedAt: number | null;
  /** It rests until then, unless no machine is running at all. */
  restUntil: number;
}

/** At most this many simulated runs at once, whatever the number of machines. */
export const MAX_CONCURRENT_RUNS = 2;
/** A machine's finished run stays visible as finished at least this long before it runs again. */
export const MIN_REST_MS = 20_000;

/**
 * The slots at the start: the first machine may start at once, the others follow spread over
 * one interval, so the runs are staggered from the beginning.
 */
export function initialSlots(
  machines: ReadonlyArray<{ id: string; tenant: string }>,
  now: number,
  intervalMs: number,
): MachineSlot[] {
  return machines.map((machine, index) => ({
    id: machine.id,
    tenant: machine.tenant,
    running: false,
    lastEndedAt: null,
    restUntil: now + Math.round((index * intervalMs) / Math.max(1, machines.length)),
  }));
}

/**
 * Which machine starts a run now, if any. A machine never runs twice at once and never next to
 * another machine of its tenant; at most {@link MAX_CONCURRENT_RUNS} run together. While nothing
 * runs at all, the machine whose rest ends first starts as soon as it has rested
 * {@link MIN_REST_MS}, so the demo almost always shows a run; a second run joins only once a
 * machine's own rest is over, which staggers the overlaps.
 */
export function nextToStart(slots: readonly MachineSlot[], now: number): string | null {
  const running = slots.filter((slot) => slot.running);
  if (running.length >= MAX_CONCURRENT_RUNS) {
    return null;
  }
  const busyTenants = new Set(running.map((slot) => slot.tenant));
  const candidates = slots
    .filter((slot) => !slot.running && !busyTenants.has(slot.tenant))
    .filter((slot) =>
      running.length === 0
        ? slot.lastEndedAt === null || now - slot.lastEndedAt >= MIN_REST_MS
        : now >= slot.restUntil,
    )
    .sort((a, b) => a.restUntil - b.restUntil || a.id.localeCompare(b.id));
  return candidates[0]?.id ?? null;
}

/** The rest after a run: the interval, give or take half of it. */
export function restAfterRun(intervalMs: number, rng: Rng): number {
  return Math.round(intervalMs * (0.5 + rng()));
}

/** Waiting after a failed call while the API is away: 5 s, doubling, at most 5 minutes. */
export function backoffMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(5 * 60_000, 5_000 * 2 ** Math.min(failures - 1, 10));
}
